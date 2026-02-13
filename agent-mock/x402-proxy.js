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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
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

async function main() {
  const argv = process.argv.slice(2);
  const port = Number(getArgValue(argv, "--port") ?? process.env.X402_PROXY_PORT ?? "8787");
  const storeDir = getArgValue(argv, "--storeDir") ?? process.env.X402_STORE_DIR ?? path.join(process.cwd(), "receipts");
  const policyFile = getArgValue(argv, "--policy") ?? process.env.X402_POLICY_FILE ?? path.join(process.cwd(), "sponsor-policy.json");

  ensureDir(storeDir);
  const receiptsDir = path.join(storeDir, "items");
  ensureDir(receiptsDir);
  const accountingPath = path.join(storeDir, "accounting.json");

  const server = http.createServer(async (req, res) => {
    const startedAt = Date.now();
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

    const raw = await readBody(req);
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
