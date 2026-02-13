#!/usr/bin/env node
const http = require("http");
const fs = require("fs");
const path = require("path");
const { keccak256, toHex } = require("viem");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

function getArgValue(argv, key) {
  const i = argv.indexOf(key);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (maxBytes && total > maxBytes) {
        try {
          req.destroy();
        } catch {}
        return reject(Object.assign(new Error("body-too-large"), { code: "body-too-large" }));
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
  res.end(html);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function parseUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function loadPolicy(policyFile) {
  const defaultPolicy = {
    policyId: "default",
    sponsorAddress: null,
    allow: { hostSuffixes: [], pathPrefixes: [] },
    limits: { maxAmountPerDay: null }
  };
  const policy = readJson(policyFile, defaultPolicy);
  return { ...defaultPolicy, ...policy, allow: { ...defaultPolicy.allow, ...(policy.allow ?? {}) }, limits: { ...defaultPolicy.limits, ...(policy.limits ?? {}) } };
}

function allowedByPolicy(policy, urlStr) {
  const u = parseUrl(urlStr);
  if (!u) return { ok: false, reason: "invalid-url" };
  const hostOk =
    policy.allow.hostSuffixes.length === 0 ||
    policy.allow.hostSuffixes.some((s) => (u.hostname ?? "").toLowerCase().endsWith(String(s).toLowerCase()));
  if (!hostOk) return { ok: false, reason: "host-not-allowed" };
  const pathOk =
    policy.allow.pathPrefixes.length === 0 ||
    policy.allow.pathPrefixes.some((p) => (u.pathname ?? "").startsWith(String(p)));
  if (!pathOk) return { ok: false, reason: "path-not-allowed" };
  return { ok: true };
}

function todayKey() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function logEvent(obj) {
  try {
    process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), ...obj }) + "\n");
  } catch {}
}

function getClientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  const ip = Array.isArray(xf) ? xf[0] : xf;
  if (ip) return String(ip).split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function parsePositiveInt(v, fallback) {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function createWindowCounter({ windowMs, limit }) {
  const buckets = new Map();
  const consume = (key) => {
    if (!limit || limit <= 0) return { ok: true, remaining: null, resetMs: windowMs };
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || now - b.startMs >= windowMs) {
      const next = { startMs: now, count: 1 };
      buckets.set(key, next);
      return { ok: true, remaining: Math.max(0, limit - 1), resetMs: windowMs };
    }
    if (b.count >= limit) {
      return { ok: false, remaining: 0, resetMs: Math.max(0, windowMs - (now - b.startMs)) };
    }
    b.count += 1;
    return { ok: true, remaining: Math.max(0, limit - b.count), resetMs: Math.max(0, windowMs - (now - b.startMs)) };
  };
  return { consume };
}

async function main() {
  const argv = process.argv.slice(2);
  const port = Number(getArgValue(argv, "--port") ?? process.env.X402_PROXY_PORT ?? "8787");
  const storeDir = getArgValue(argv, "--storeDir") ?? process.env.X402_STORE_DIR ?? path.join(process.cwd(), "receipts");
  const policyFile = getArgValue(argv, "--policy") ?? process.env.X402_POLICY_FILE ?? path.join(process.cwd(), "sponsor-policy.json");
  const maxBodyBytes = parsePositiveInt(process.env.X402_MAX_BODY_BYTES, 64 * 1024);
  const rateWindowMs = parsePositiveInt(process.env.X402_RATE_WINDOW_MS, 60_000);
  const rateIpPerWindow = parsePositiveInt(process.env.X402_RATE_LIMIT_IP, 60);
  const ratePayerPerWindow = parsePositiveInt(process.env.X402_RATE_LIMIT_PAYER, 120);
  const ipLimiter = createWindowCounter({ windowMs: rateWindowMs, limit: rateIpPerWindow });
  const payerLimiter = createWindowCounter({ windowMs: rateWindowMs, limit: ratePayerPerWindow });

  ensureDir(storeDir);
  const receiptsDir = path.join(storeDir, "items");
  ensureDir(receiptsDir);
  const accountingPath = path.join(storeDir, "accounting.json");

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
    if (req.method === "GET" && req.url === "/") {
      const accounting = readJson(accountingPath, { days: {} });
      let receipts = [];
      try {
        receipts = fs
          .readdirSync(receiptsDir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => {
            const p = path.join(receiptsDir, n);
            return { name: n, mtimeMs: fs.statSync(p).mtimeMs };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 20)
          .map((r) => r.name.replace(/\.json$/, ""));
      } catch {}

      const receiptLinks = receipts
        .map((id) => `<li><a href="/receipts/${escapeHtml(id)}">${escapeHtml(id)}</a></li>`)
        .join("");

      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>x402 proxy</title>
  </head>
  <body>
    <h1>x402 proxy</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/stats">/stats</a></li>
      <li><a href="/receipts">/receipts</a></li>
    </ul>
    <h2>Today</h2>
    <pre>${escapeHtml(JSON.stringify(accounting.days[todayKey()] ?? {}, null, 2))}</pre>
    <h2>Latest receipts</h2>
    <ol>${receiptLinks || "<li>(none)</li>"}</ol>
  </body>
</html>`;
      return sendHtml(res, 200, html);
    }

    if (req.method === "GET" && req.url === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && req.url === "/stats") {
      const accounting = readJson(accountingPath, { days: {} });
      let receiptCount = 0;
      try {
        receiptCount = fs.readdirSync(receiptsDir).filter((n) => n.endsWith(".json")).length;
      } catch {}
      return sendJson(res, 200, { ok: true, accounting, receiptCount });
    }

    if (req.method === "GET" && req.url === "/receipts") {
      let receipts = [];
      try {
        receipts = fs
          .readdirSync(receiptsDir)
          .filter((n) => n.endsWith(".json"))
          .map((n) => {
            const p = path.join(receiptsDir, n);
            return { receiptId: n.replace(/\.json$/, ""), mtimeMs: fs.statSync(p).mtimeMs };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, 100);
      } catch {}
      return sendJson(res, 200, { ok: true, receipts });
    }

    if (req.method === "GET" && req.url && req.url.startsWith("/receipts/")) {
      const receiptId = req.url.split("/").pop();
      const filePath = path.join(receiptsDir, `${receiptId}.json`);
      if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "not-found" });
      res.writeHead(200, { "content-type": "application/json" });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    if (req.method !== "POST" || req.url !== "/pay") {
      return sendJson(res, 404, { error: "not-found" });
    }

    const clientIp = getClientIp(req);
    const ipRate = ipLimiter.consume(clientIp);
    if (!ipRate.ok) {
      logEvent({ event: "x402.rateLimit", ok: false, kind: "ip", clientIp, resetMs: ipRate.resetMs, ms: Date.now() - startedAt });
      res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(ipRate.resetMs / 1000)) });
      return res.end(JSON.stringify({ error: "rate-limited", kind: "ip" }));
    }

    const ct = String(req.headers["content-type"] ?? "");
    if (!ct.toLowerCase().includes("application/json")) {
      logEvent({ event: "x402.pay", ok: false, error: "unsupported-content-type", contentType: ct, clientIp, ms: Date.now() - startedAt });
      return sendJson(res, 415, { error: "unsupported-content-type" });
    }

    let raw;
    try {
      raw = await readBody(req, maxBodyBytes);
    } catch (e) {
      const code = e?.code ?? "";
      if (code === "body-too-large") {
        logEvent({ event: "x402.pay", ok: false, error: "body-too-large", clientIp, ms: Date.now() - startedAt });
        return sendJson(res, 413, { error: "body-too-large" });
      }
      throw e;
    }
    let body;
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      logEvent({ event: "x402.pay", ok: false, error: "invalid-json", ms: Date.now() - startedAt });
      return sendJson(res, 400, { error: "invalid-json" });
    }

    const url = body.url;
    const method = body.method ?? "GET";
    const amount = String(body.amount ?? "0");
    const currency = String(body.currency ?? "USD");
    const payerAddress = body.payerAddress ?? null;
    const agentId = body.agentId ?? null;
    const chainId = body.chainId ?? null;
    const sponsorAddress = body.sponsorAddress ?? null;
    const policyId = body.policyId ?? "default";
    const metadata = body.metadata ?? null;

    if (!url) {
      logEvent({ event: "x402.pay", ok: false, error: "missing-url", ms: Date.now() - startedAt });
      return sendJson(res, 400, { error: "missing-url" });
    }
    if (String(url).length > 2048) {
      logEvent({ event: "x402.pay", ok: false, error: "url-too-long", ms: Date.now() - startedAt });
      return sendJson(res, 400, { error: "url-too-long" });
    }
    if (String(method).length > 32) {
      logEvent({ event: "x402.pay", ok: false, error: "method-too-long", ms: Date.now() - startedAt });
      return sendJson(res, 400, { error: "method-too-long" });
    }
    if (!/^[0-9]+$/.test(amount)) {
      logEvent({ event: "x402.pay", ok: false, error: "invalid-amount", amount, ms: Date.now() - startedAt });
      return sendJson(res, 400, { error: "invalid-amount" });
    }
    if (metadata && JSON.stringify(metadata).length > 16 * 1024) {
      logEvent({ event: "x402.pay", ok: false, error: "metadata-too-large", ms: Date.now() - startedAt });
      return sendJson(res, 400, { error: "metadata-too-large" });
    }

    if (payerAddress) {
      const payerRate = payerLimiter.consume(String(payerAddress).toLowerCase());
      if (!payerRate.ok) {
        logEvent({
          event: "x402.rateLimit",
          ok: false,
          kind: "payer",
          payerAddress,
          clientIp,
          resetMs: payerRate.resetMs,
          ms: Date.now() - startedAt
        });
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(Math.ceil(payerRate.resetMs / 1000)) });
        return res.end(JSON.stringify({ error: "rate-limited", kind: "payer" }));
      }
    }

    const policy = loadPolicy(policyFile);
    if (policy.policyId && policyId !== policy.policyId) {
      logEvent({ event: "x402.pay", ok: false, error: "policy-id-mismatch", policyId, ms: Date.now() - startedAt });
      return sendJson(res, 403, { error: "policy-id-mismatch" });
    }
    if (policy.sponsorAddress && sponsorAddress && String(policy.sponsorAddress).toLowerCase() !== String(sponsorAddress).toLowerCase()) {
      logEvent({ event: "x402.pay", ok: false, error: "sponsor-mismatch", sponsorAddress, ms: Date.now() - startedAt });
      return sendJson(res, 403, { error: "sponsor-mismatch" });
    }

    const allow = allowedByPolicy(policy, url);
    if (!allow.ok) {
      logEvent({ event: "x402.pay", ok: false, error: allow.reason, url, ms: Date.now() - startedAt });
      return sendJson(res, 403, { error: allow.reason });
    }

    const accounting = readJson(accountingPath, { days: {} });
    const day = todayKey();
    accounting.days[day] = accounting.days[day] ?? { total: "0", bySponsor: {}, byPayer: {} };
    const dayTotal = BigInt(accounting.days[day].total);
    const amountInt = BigInt(amount);

    if (policy.limits.maxAmountPerDay !== null) {
      const max = BigInt(String(policy.limits.maxAmountPerDay));
      if (dayTotal + amountInt > max) {
        logEvent({ event: "x402.pay", ok: false, error: "daily-limit-exceeded", amount, day, ms: Date.now() - startedAt });
        return sendJson(res, 402, { error: "daily-limit-exceeded" });
      }
    }

    accounting.days[day].total = (dayTotal + amountInt).toString();
    if (sponsorAddress) {
      const cur = BigInt(accounting.days[day].bySponsor[sponsorAddress] ?? "0");
      accounting.days[day].bySponsor[sponsorAddress] = (cur + amountInt).toString();
    }
    if (payerAddress) {
      const cur = BigInt(accounting.days[day].byPayer[payerAddress] ?? "0");
      accounting.days[day].byPayer[payerAddress] = (cur + amountInt).toString();
    }
    writeJson(accountingPath, accounting);

    const createdAt = new Date().toISOString();
    const baseReceipt = {
      version: "1",
      createdAt,
      payer: { address: payerAddress, agentId },
      sponsor: sponsorAddress ? { address: sponsorAddress, policyId } : undefined,
      payment: { amount, currency, chainId },
      request: { url, method },
      metadata
    };

    const receiptId = keccak256(toHex(JSON.stringify(baseReceipt)));
    const finalReceiptUri = `file://${path.join(receiptsDir, `${receiptId}.json`)}`;
    const receipt = { ...baseReceipt, receiptId, receiptUri: finalReceiptUri };

    writeJson(path.join(receiptsDir, `${receiptId}.json`), receipt);
    logEvent({
      event: "x402.pay",
      ok: true,
      receiptId,
      receiptUri: finalReceiptUri,
      amount,
      currency,
      payerAddress,
      sponsorAddress,
      policyId,
      url,
      method,
      ms: Date.now() - startedAt
    });
    return sendJson(res, 200, { receiptId, receiptUri: finalReceiptUri });
  });

  server.listen(port, () => {
    logEvent({ event: "x402.start", ok: true, port, storeDir, policyFile });
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
