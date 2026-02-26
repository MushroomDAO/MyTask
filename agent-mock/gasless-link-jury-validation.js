#!/usr/bin/env node
const {
  createPublicClient,
  createWalletClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  concat,
  pad,
  decodeEventLog,
  keccak256,
  toHex
} = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const nodeHttp = require("http");
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function atomicWriteFile(filePath, data) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, data);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {}
    throw e;
  }
}

function writeJsonAtomic(filePath, obj) {
  atomicWriteFile(filePath, JSON.stringify(obj, null, 2));
}

function readJsonRecovering(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    try {
      if (fs.existsSync(filePath)) {
        const recoveredPath = `${filePath}.corrupt-${Date.now()}`;
        fs.renameSync(filePath, recoveredPath);
        logEvent({ event: "orchestrator.recover", ok: true, filePath, recoveredPath });
      }
    } catch {}
    return fallback;
  }
}

function getArgValue(argv, key) {
  const i = argv.indexOf(key);
  if (i === -1) return undefined;
  return argv[i + 1];
}

function parseBool(v, defaultValue) {
  if (v === undefined) return defaultValue;
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`Invalid boolean: ${v}`);
}

function normalizeHexAddress(v) {
  if (!v) return v;
  const hex = v.startsWith("0x") ? v : `0x${v}`;
  return hex.toLowerCase();
}

function randomId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
}

function stableStringify(v) {
  if (v === null) return "null";
  const t = typeof v;
  if (t === "string") return JSON.stringify(v);
  if (t === "number") return Number.isFinite(v) ? String(v) : "null";
  if (t === "boolean") return v ? "true" : "false";
  if (t === "bigint") return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x)).join(",")}]`;
  if (t === "object") {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  }
  return "null";
}

function _tryParseReceiptJson(receiptUri) {
  if (!receiptUri) return null;
  const raw = String(receiptUri).trim();
  if (!raw) return null;

  try {
    if (raw.startsWith("{") || raw.startsWith("[")) return JSON.parse(raw);
  } catch {}

  const lower = raw.toLowerCase();
  if (lower.startsWith("data:application/json;base64,")) {
    const base64 = raw.slice("data:application/json;base64,".length);
    try {
      const decoded = Buffer.from(base64, "base64").toString("utf8");
      return JSON.parse(decoded);
    } catch {}
  }

  if (lower.startsWith("data:application/json,")) {
    const encoded = raw.slice("data:application/json,".length);
    try {
      const decoded = decodeURIComponent(encoded);
      return JSON.parse(decoded);
    } catch {}
  }

  return null;
}

function deriveReceiptId(receiptUri) {
  const obj = _tryParseReceiptJson(receiptUri);
  if (obj != null) {
    const canonical = stableStringify(obj);
    return keccak256(toHex(canonical));
  }
  return keccak256(toHex(String(receiptUri ?? "").trim()));
}

function buildDataJsonUri(payload) {
  const canonical = stableStringify(payload);
  const base64 = Buffer.from(canonical, "utf8").toString("base64");
  return `data:application/json;base64,${base64}`;
}

function deriveErc8004RequestHash({ chainId, taskId, agentId, validatorAddress, tag, requestUri }) {
  const bytes = encodeAbiParameters(
    [
      { name: "chainId", type: "uint256" },
      { name: "taskId", type: "bytes32" },
      { name: "agentId", type: "uint256" },
      { name: "validatorAddress", type: "address" },
      { name: "tag", type: "bytes32" },
      { name: "requestUri", type: "string" }
    ],
    [BigInt(chainId), taskId, BigInt(agentId), validatorAddress, tag, requestUri]
  );
  return keccak256(bytes);
}

let LOG_FILE = null;
let LOG_MAX_BYTES = 0;
let LOG_BASE_FIELDS = {};

function rotateLogIfNeeded(filePath, maxBytes) {
  if (!filePath || !maxBytes || maxBytes <= 0) return;
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    if (st.size < maxBytes) return;
    const rotatedPath = `${filePath}.rotated-${Date.now()}`;
    fs.renameSync(filePath, rotatedPath);
  } catch {}
}

function logEvent(obj) {
  try {
    const lineObj = { ts: new Date().toISOString(), ...LOG_BASE_FIELDS, ...obj };
    process.stdout.write(JSON.stringify(lineObj) + "\n");
    if (LOG_FILE) {
      rotateLogIfNeeded(LOG_FILE, LOG_MAX_BYTES);
      fs.appendFileSync(LOG_FILE, JSON.stringify(lineObj) + "\n");
    }
  } catch {}
}

function safeErrorString(e) {
  try {
    if (!e) return "unknown-error";
    if (e instanceof Error) return e.stack || e.message || String(e);
    return typeof e === "string" ? e : JSON.stringify(e);
  } catch {
    try {
      return String(e);
    } catch {
      return "unknown-error";
    }
  }
}

function startSpan({ traceId, parentSpanId, name, ...fields }) {
  const spanId = randomId();
  const startedAtMs = Date.now();
  logEvent({
    event: "trace.spanStart",
    ok: true,
    traceId,
    spanId,
    parentSpanId: parentSpanId ?? null,
    name,
    ...fields
  });
  return { spanId, startedAtMs };
}

function endSpan({ traceId, spanId, parentSpanId, name, startedAtMs, ok, ...fields }) {
  const durationMs = Math.max(0, Date.now() - Number(startedAtMs ?? Date.now()));
  logEvent({
    event: "trace.spanEnd",
    ok: Boolean(ok),
    traceId,
    spanId,
    parentSpanId: parentSpanId ?? null,
    name,
    durationMs,
    ...fields
  });
}

async function withSpan({ traceId, parentSpanId, name, ...fields }, fn) {
  if (!traceId) return await fn({ traceId: null, spanId: null });
  const span = startSpan({ traceId, parentSpanId, name, ...fields });
  try {
    const out = await fn({ traceId, spanId: span.spanId, parentSpanId });
    endSpan({ traceId, spanId: span.spanId, parentSpanId, name, startedAtMs: span.startedAtMs, ok: true });
    return out;
  } catch (e) {
    endSpan({
      traceId,
      spanId: span.spanId,
      parentSpanId,
      name,
      startedAtMs: span.startedAtMs,
      ok: false,
      error: safeErrorString(e)
    });
    throw e;
  }
}

async function withRetries(fn, { retries, baseDelayMs, label }) {
  const n = retries ?? 2;
  const base = baseDelayMs ?? 250;
  for (let attempt = 0; attempt <= n; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= n) throw e;
      const delay = base * 2 ** attempt;
      logEvent({ event: "retry", ok: false, label, attempt: attempt + 1, delayMs: delay, error: String(e) });
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

async function bundlerRpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Bundler HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.error) throw new Error(`Bundler RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function rpcJson(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json.error) throw new Error(`RPC error: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function detectChainIdFromRpc(rpcUrl, fallback) {
  try {
    const v = await rpcJson(rpcUrl, "eth_chainId", []);
    if (typeof v !== "string") return fallback;
    return Number.parseInt(v, 16);
  } catch {
    return fallback;
  }
}

async function main() {
  const argv = process.argv.slice(2);

  const mode = getArgValue(argv, "--mode") ?? process.env.MODE ?? "linkJuryValidation";

  const dryRun = parseBool(getArgValue(argv, "--dryRun"), true);

  const rpcUrl = getArgValue(argv, "--rpcUrl") ?? requireEnv("RPC_URL");

  const chainId = Number(getArgValue(argv, "--chainId") ?? process.env.CHAIN_ID ?? (await detectChainIdFromRpc(rpcUrl, 1)));

  const runId = getArgValue(argv, "--runId") ?? process.env.RUN_ID ?? randomId();
  LOG_FILE = getArgValue(argv, "--logFile") ?? process.env.ORCHESTRATOR_LOG_FILE ?? null;
  LOG_MAX_BYTES = Number(getArgValue(argv, "--logMaxBytes") ?? process.env.ORCHESTRATOR_LOG_MAX_BYTES ?? "0");
  LOG_BASE_FIELDS = { service: "orchestrator", mode, runId };

  const entryPoint = getArgValue(argv, "--entryPoint") ??
    process.env.ENTRYPOINT_ADDRESS ??
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

  const taskEscrow = normalizeHexAddress(getArgValue(argv, "--taskEscrow") ?? requireEnv("TASK_ESCROW_ADDRESS"));

  const publicClient = createPublicClient({
    chain: { id: chainId, name: "custom", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl)
  });

  logEvent({ event: "orchestrator.start", ok: true, chainId, dryRun });

  if (mode === "watchEvidence") {
    const once = parseBool(getArgValue(argv, "--once"), false);
    const evidenceEventAbi = [
      {
        type: "event",
        name: "EvidenceSubmitted",
        anonymous: false,
        inputs: [
          { indexed: true, name: "taskId", type: "bytes32" },
          { indexed: false, name: "evidenceUri", type: "string" },
          { indexed: false, name: "timestamp", type: "uint256" }
        ]
      }
    ];

    let unwatch = () => {};
    unwatch = publicClient.watchContractEvent({
      address: taskEscrow,
      abi: evidenceEventAbi,
      eventName: "EvidenceSubmitted",
      onLogs: (logs) => {
        for (const log of logs) {
          const args = log.args ?? {};
          const traceId = String(args.taskId ?? randomId());
          logEvent({ event: "orchestrator.evidenceSubmitted", ok: true, traceId, mode, address: taskEscrow, log: { ...log, args } });
          if (once) {
            unwatch();
            process.exit(0);
          }
        }
      }
    });

    return;
  }

  if (mode === "orchestrateTasks") {
    const once = parseBool(getArgValue(argv, "--once"), false);
    const autoAccept = parseBool(getArgValue(argv, "--autoAccept"), true);
    const autoSubmit = parseBool(getArgValue(argv, "--autoSubmit"), true);
    const autoFinalize = parseBool(getArgValue(argv, "--autoFinalize"), true);
    const autoFastForward = parseBool(getArgValue(argv, "--autoFastForward"), true);
    const requireManualFinalize = parseBool(getArgValue(argv, "--requireManualFinalize"), false);
    const scanOnStart = parseBool(getArgValue(argv, "--scanOnStart") ?? process.env.ORCH_SCAN_ON_START, true);
    const exitAfterScan = parseBool(getArgValue(argv, "--exitAfterScan") ?? process.env.ORCH_EXIT_AFTER_SCAN, false);
    const lookbackBlocks = BigInt(getArgValue(argv, "--lookbackBlocks") ?? process.env.ORCH_LOOKBACK_BLOCKS ?? "5000");
    const stateFile =
      getArgValue(argv, "--stateFile") ??
      process.env.ORCH_STATE_FILE ??
      path.join(process.cwd(), "out", "orchestrator-state.json");
    ensureDir(path.dirname(stateFile));
    const state = readJsonRecovering(stateFile, { version: 1, tasks: {}, lastScanToBlock: "0" });
    if (!state.tasks || typeof state.tasks !== "object") state.tasks = {};

    const serveApi = parseBool(getArgValue(argv, "--serve") ?? process.env.ORCH_SERVE, false);
    const apiPort = Number(getArgValue(argv, "--port") ?? process.env.ORCH_PORT ?? "8791");
    const startedAtMs = Date.now();
    const counters = {
      tasksProcessed: 0,
      tasksFailed: 0,
      rewardsTriggered: 0,
      rewardsFailed: 0,
      x402PayOk: 0,
      x402PayFail: 0
    };

    const sendJson = (res, code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    };

    if (serveApi) {
      const server = nodeHttp.createServer((req, res) => {
        const traceId = req.headers["x-trace-id"] ? String(req.headers["x-trace-id"]) : randomId();
        res.setHeader("x-trace-id", traceId);
        const reqStartedAtMs = Date.now();
        const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const p = u.pathname;

        const sendHtml = (code, html) => {
          res.writeHead(code, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(html) });
          res.end(html);
        };

        const roleAddresses = {
          community: communityAccount.address,
          taskor: account.address,
          supplier: supplierAccount.address,
          jury: validatorAccount.address
        };

        const uiPage = (role) => {
          const roleJson = JSON.stringify(role);
          const addrsJson = JSON.stringify(roleAddresses);
          const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyTask Orchestrator – ${role ?? "Dashboard"}</title>
    <style>
      :root { color-scheme: light dark; }
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial; margin: 20px; }
      a { color: inherit; }
      .top { display: flex; gap: 12px; align-items: baseline; justify-content: space-between; flex-wrap: wrap; }
      .nav { display: flex; gap: 10px; flex-wrap: wrap; }
      .pill { padding: 6px 10px; border: 1px solid rgba(127,127,127,0.35); border-radius: 999px; text-decoration: none; }
      .pill.active { background: rgba(127,127,127,0.18); }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin: 12px 0 18px; }
      .card { border: 1px solid rgba(127,127,127,0.35); border-radius: 10px; padding: 10px; }
      .muted { opacity: 0.75; }
      table { width: 100%; border-collapse: collapse; }
      th, td { border-bottom: 1px solid rgba(127,127,127,0.2); padding: 8px; text-align: left; vertical-align: top; }
      th { position: sticky; top: 0; background: rgba(20,20,20,0.04); }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; }
      .nowrap { white-space: nowrap; }
      .wrap { word-break: break-word; }
      .right { text-align: right; }
      .rowErr { color: #b00020; }
      @media (prefers-color-scheme: dark) { th { background: rgba(255,255,255,0.06); } .rowErr { color: #ff6b6b; } }
    </style>
  </head>
  <body>
    <div class="top">
      <div>
        <div class="mono muted">runId: ${runId} • mode: ${mode} • api: ${apiPort}</div>
        <h2 style="margin: 6px 0 0;">${role ?? "Dashboard"}</h2>
      </div>
      <div class="nav">
        <a class="pill ${role === null ? "active" : ""}" href="/ui">Overview</a>
        <a class="pill ${role === "community" ? "active" : ""}" href="/ui/community">Community</a>
        <a class="pill ${role === "taskor" ? "active" : ""}" href="/ui/taskor">Taskor</a>
        <a class="pill ${role === "supplier" ? "active" : ""}" href="/ui/supplier">Supplier</a>
        <a class="pill ${role === "jury" ? "active" : ""}" href="/ui/jury">Jury</a>
        <a class="pill" href="/metrics">JSON: /metrics</a>
        <a class="pill" href="/state">JSON: /state</a>
      </div>
    </div>

    <div class="grid" id="summary"></div>
    <div class="card">
      <div class="mono muted" id="roleAddrs"></div>
    </div>
    <div style="height: 14px;"></div>

    <div class="card">
      <div class="top">
        <div>
          <div class="muted">Tasks</div>
          <div class="mono muted" id="tasksMeta"></div>
        </div>
        <div class="mono muted" id="lastRefreshed"></div>
      </div>
      <div style="height: 10px;"></div>
      <div style="overflow: auto;">
        <table>
          <thead>
            <tr>
              <th class="nowrap">taskId</th>
              <th class="nowrap">state</th>
              <th class="nowrap">reward</th>
              <th>participants</th>
              <th>links</th>
              <th class="nowrap">attempts</th>
              <th>last</th>
            </tr>
          </thead>
          <tbody id="tasks"></tbody>
        </table>
      </div>
    </div>

    <script>
      const role = ${roleJson};
      const addrs = ${addrsJson};
      const taskStateLabel = ${taskStateLabel.toString()};
      const shortHex = (v) => {
        const s = String(v ?? "");
        if (!s.startsWith("0x") || s.length < 16) return s;
        return s.slice(0, 6) + "…" + s.slice(-4);
      };
      const fmtNum = (v) => {
        const s = String(v ?? "");
        if (!/^[0-9]+$/.test(s)) return s;
        try { return Number(s).toLocaleString(); } catch { return s; }
      };
      const el = (tag, props = {}, children = []) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(props)) {
          if (k === "class") e.className = v;
          else if (k === "text") e.textContent = v;
          else if (k === "href") e.setAttribute("href", v);
          else e.setAttribute(k, v);
        }
        for (const c of children) e.appendChild(c);
        return e;
      };
      const link = (href, text) => el("a", { href, class: "mono wrap", text });

      const roleFilter = (entry) => {
        if (role == null) return true;
        const t = entry?.task;
        if (role === "community") return t?.community && t.community.toLowerCase() === addrs.community.toLowerCase();
        if (role === "taskor") return t?.taskor && t.taskor.toLowerCase() === addrs.taskor.toLowerCase();
        if (role === "supplier") return t?.supplier && t.supplier.toLowerCase() === addrs.supplier.toLowerCase();
        if (role === "jury") return Boolean(entry?.requestHash || entry?.validation?.request?.requestHash || (t?.juryTaskHash && t.juryTaskHash !== "0x0000000000000000000000000000000000000000000000000000000000000000"));
        return true;
      };

      async function load() {
        const [metricsRes, stateRes] = await Promise.all([fetch("/metrics"), fetch("/state")]);
        const metrics = await metricsRes.json();
        const state = await stateRes.json();
        const tasksAll = Object.values(state?.state?.tasks ?? {}).filter((x) => x && typeof x === "object");
        const tasks = tasksAll.filter(roleFilter);

        document.getElementById("lastRefreshed").textContent = "refreshed: " + new Date().toISOString();
        document.getElementById("roleAddrs").textContent =
          "community: " + addrs.community + " • taskor: " + addrs.taskor + " • supplier: " + addrs.supplier + " • jury: " + addrs.jury;
        document.getElementById("tasksMeta").textContent = "showing " + tasks.length + " / " + tasksAll.length;

        const byState = new Map();
        for (const e of tasks) {
          const s = Number(e?.task?.state ?? e?.lastStatus ?? -1);
          byState.set(s, (byState.get(s) ?? 0) + 1);
        }

        const summary = document.getElementById("summary");
        summary.innerHTML = "";
        summary.appendChild(el("div", { class: "card" }, [
          el("div", { class: "muted", text: "Uptime (ms)" }),
          el("div", { class: "mono", text: fmtNum(metrics?.uptimeMs ?? "") })
        ]));
        summary.appendChild(el("div", { class: "card" }, [
          el("div", { class: "muted", text: "Processed / Failed" }),
          el("div", { class: "mono", text: fmtNum(metrics?.counters?.tasksProcessed ?? 0) + " / " + fmtNum(metrics?.counters?.tasksFailed ?? 0) })
        ]));
        summary.appendChild(el("div", { class: "card" }, [
          el("div", { class: "muted", text: "x402 Pay Ok / Fail" }),
          el("div", { class: "mono", text: fmtNum(metrics?.counters?.x402PayOk ?? 0) + " / " + fmtNum(metrics?.counters?.x402PayFail ?? 0) })
        ]));
        summary.appendChild(el("div", { class: "card" }, [
          el("div", { class: "muted", text: "Rewards Ok / Fail" }),
          el("div", { class: "mono", text: fmtNum(metrics?.counters?.rewardsTriggered ?? 0) + " / " + fmtNum(metrics?.counters?.rewardsFailed ?? 0) })
        ]));

        const tbody = document.getElementById("tasks");
        tbody.innerHTML = "";
        tasks.sort((a, b) => String(b?.lastAttemptAt ?? "").localeCompare(String(a?.lastAttemptAt ?? "")));
        for (const e of tasks) {
          const t = e.task ?? {};
          const stateNum = Number(t.state ?? e.lastStatus ?? -1);
          const err = e.lastError ? true : false;

          const participants = el("div", { class: "mono wrap" }, [
            el("div", { text: "community: " + shortHex(t.community) }),
            el("div", { text: "taskor: " + shortHex(t.taskor) }),
            el("div", { text: "supplier: " + shortHex(t.supplier) })
          ]);

          const linksCol = el("div", { class: "wrap" });
          if (t.evidenceUri) linksCol.appendChild(el("div", {}, [link(t.evidenceUri, "evidence")]));
          if (e?.taskReceipt?.receiptUri) linksCol.appendChild(el("div", {}, [link(e.taskReceipt.receiptUri, "taskReceipt")]));
          if (e?.validation?.request?.requestUri) linksCol.appendChild(el("div", {}, [link(e.validation.request.requestUri, "validationRequest")]));
          if (e?.validation?.response?.responseUri) linksCol.appendChild(el("div", {}, [link(e.validation.response.responseUri, "validationResponse")]));

          const lastCol = el("div", { class: "wrap" }, [
            el("div", { class: "mono muted", text: e.lastAttemptAt ?? "" }),
            err ? el("div", { class: "mono rowErr", text: String(e.lastError) }) : el("div", { class: "mono muted", text: "" })
          ]);

          const tr = document.createElement("tr");
          if (err) tr.className = "rowErr";
          tr.appendChild(el("td", { class: "mono nowrap", text: shortHex(t.taskId || e.taskId) }));
          tr.appendChild(el("td", { class: "mono nowrap", text: taskStateLabel(stateNum) }));
          tr.appendChild(el("td", { class: "mono nowrap right", text: fmtNum(t.reward) }));
          tr.appendChild(el("td", {}, [participants]));
          tr.appendChild(el("td", {}, [linksCol]));
          tr.appendChild(el("td", { class: "mono nowrap right", text: fmtNum(e.attempts ?? 0) }));
          tr.appendChild(el("td", {}, [lastCol]));
          tbody.appendChild(tr);
        }
      }

      load().catch((e) => {
        const s = document.getElementById("summary");
        s.innerHTML = "";
        s.appendChild(el("div", { class: "card rowErr" }, [
          el("div", { class: "muted", text: "UI error" }),
          el("div", { class: "mono", text: String(e && (e.stack || e.message) || e) })
        ]));
      });
    </script>
  </body>
</html>`;
          return html;
        };

        if (req.method === "GET" && (p === "/" || p === "/ui")) {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendHtml(200, uiPage(null));
        }
        if (req.method === "GET" && p === "/ui/community") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendHtml(200, uiPage("community"));
        }
        if (req.method === "GET" && p === "/ui/taskor") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendHtml(200, uiPage("taskor"));
        }
        if (req.method === "GET" && p === "/ui/supplier") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendHtml(200, uiPage("supplier"));
        }
        if (req.method === "GET" && p === "/ui/jury") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendHtml(200, uiPage("jury"));
        }

        if (req.method === "GET" && p === "/health") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendJson(res, 200, { ok: true, mode, runId });
        }
        if (req.method === "GET" && p === "/metrics") {
          const summary = {
            ok: true,
            mode,
            runId,
            uptimeMs: Date.now() - startedAtMs,
            counters,
            state: {
              stateFile,
              tasksTotal: Object.keys(state.tasks).length,
              tasksDone: Object.values(state.tasks).filter((t) => t?.done === true).length,
              lastScanToBlock: state.lastScanToBlock ?? "0"
            }
          };
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendJson(res, 200, summary);
        }
        if (req.method === "GET" && p === "/state") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200, durationMs: Date.now() - reqStartedAtMs });
          return sendJson(res, 200, { ok: true, state });
        }
        logEvent({ event: "orchestrator.http", ok: false, traceId, method: req.method, path: p, code: 404, durationMs: Date.now() - reqStartedAtMs });
        return sendJson(res, 404, { error: "not-found" });
      });
      server.listen(apiPort, () => logEvent({ event: "orchestrator.serve", ok: true, port: apiPort }));
    }
    const evidenceUri =
      getArgValue(argv, "--evidenceUri") ??
      process.env.EVIDENCE_URI ??
      "ipfs://evidence";
    let receiptUri = getArgValue(argv, "--receiptUri") ?? process.env.RECEIPT_URI;

    const privateKeyRaw =
      getArgValue(argv, "--privateKey") ??
      process.env.PRIVATE_KEY ??
      (dryRun ? `0x${"1".padStart(64, "0")}` : requireEnv("PRIVATE_KEY"));
    const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
    const account = privateKeyToAccount(privateKey);

    const communityPrivateKeyRaw = getArgValue(argv, "--communityPrivateKey") ?? process.env.COMMUNITY_PRIVATE_KEY;
    const communityAccount = communityPrivateKeyRaw
      ? privateKeyToAccount(communityPrivateKeyRaw.startsWith("0x") ? communityPrivateKeyRaw : `0x${communityPrivateKeyRaw}`)
      : account;

    const supplierPrivateKeyRaw = getArgValue(argv, "--supplierPrivateKey") ?? process.env.SUPPLIER_PRIVATE_KEY;
    const supplierAccount = supplierPrivateKeyRaw
      ? privateKeyToAccount(supplierPrivateKeyRaw.startsWith("0x") ? supplierPrivateKeyRaw : `0x${supplierPrivateKeyRaw}`)
      : account;

    const validatorPrivateKeyRaw = getArgValue(argv, "--validatorPrivateKey") ?? process.env.VALIDATOR_PRIVATE_KEY;
    const validatorAccount = validatorPrivateKeyRaw
      ? privateKeyToAccount(validatorPrivateKeyRaw.startsWith("0x") ? validatorPrivateKeyRaw : `0x${validatorPrivateKeyRaw}`)
      : account;

    const juryContractAddress = normalizeHexAddress(
      getArgValue(argv, "--juryContract") ?? process.env.JURY_CONTRACT_ADDRESS ?? requireEnv("JURY_CONTRACT_ADDRESS")
    );
    const agentId = BigInt(getArgValue(argv, "--agentId") ?? process.env.AGENT_ID ?? "1");

    const validationTagRaw = getArgValue(argv, "--validationTag") ?? process.env.VALIDATION_TAG;
    const validationTag = validationTagRaw
      ? validationTagRaw.startsWith("0x")
        ? validationTagRaw
        : toHex(validationTagRaw, { size: 32 })
      : "0x0000000000000000000000000000000000000000000000000000000000000000";
    const validationMinCount = BigInt(getArgValue(argv, "--validationMinCount") ?? process.env.VALIDATION_MIN_COUNT ?? "0");
    const validationMinAvg = Number(getArgValue(argv, "--validationMinAvg") ?? process.env.VALIDATION_MIN_AVG ?? "0");
    const validationMinUnique = Number(getArgValue(argv, "--validationMinUnique") ?? process.env.VALIDATION_MIN_UNIQUE ?? "0");
    const validationRequestUriRaw = getArgValue(argv, "--validationRequestUri") ?? process.env.VALIDATION_REQUEST_URI ?? null;
    const validationResponseUriRaw = getArgValue(argv, "--validationResponseUri") ?? process.env.VALIDATION_RESPONSE_URI ?? null;
    const validationScore = Number(getArgValue(argv, "--validationScore") ?? process.env.VALIDATION_SCORE ?? "80");
    let validationReceiptUri = getArgValue(argv, "--validationReceiptUri") ?? process.env.VALIDATION_RECEIPT_URI;

    const enforceAgentOwner = parseBool(getArgValue(argv, "--enforceAgentOwner") ?? process.env.ENFORCE_AGENT_OWNER, true);
    const expectedAgentOwnerRaw = getArgValue(argv, "--expectedAgentOwner") ?? process.env.EXPECTED_AGENT_OWNER ?? "taskor";

    const x402ProxyUrl = getArgValue(argv, "--x402ProxyUrl") ?? process.env.X402_PROXY_URL;
    const x402Currency = getArgValue(argv, "--x402Currency") ?? process.env.X402_CURRENCY ?? "USD";
    const x402TaskAmount = getArgValue(argv, "--x402TaskAmount") ?? process.env.X402_TASK_AMOUNT ?? "0";
    const x402ValidationAmount = getArgValue(argv, "--x402ValidationAmount") ?? process.env.X402_VALIDATION_AMOUNT ?? "0";
    const x402SponsorAddress = getArgValue(argv, "--x402Sponsor") ?? process.env.X402_SPONSOR_ADDRESS ?? null;
    const x402PolicyId = getArgValue(argv, "--x402PolicyId") ?? process.env.X402_POLICY_ID ?? "default";

    const myShopItemsAddress = normalizeHexAddress(
      getArgValue(argv, "--myShopItems") ?? process.env.MYSHOP_ITEMS_ADDRESS ?? null
    );
    const rewardItemIdRaw = getArgValue(argv, "--rewardItemId") ?? process.env.REWARD_ITEM_ID ?? null;
    const rewardItemId = rewardItemIdRaw ? BigInt(rewardItemIdRaw) : null;
    const rewardQuantity = BigInt(getArgValue(argv, "--rewardQuantity") ?? process.env.REWARD_QUANTITY ?? "1");
    const rewardValue = BigInt(getArgValue(argv, "--rewardValue") ?? process.env.REWARD_VALUE ?? "0");
    const rewardExtraDataHexRaw =
      getArgValue(argv, "--rewardExtraDataHex") ?? process.env.REWARD_EXTRA_DATA_HEX ?? null;

    const walletClient = createWalletClient({
      account,
      chain: {
        id: chainId,
        name: "custom",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
      },
      transport: http(rpcUrl)
    });

    const communityWalletClient = createWalletClient({
      account: communityAccount,
      chain: {
        id: chainId,
        name: "custom",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
      },
      transport: http(rpcUrl)
    });

    const validatorWalletClient = createWalletClient({
      account: validatorAccount,
      chain: {
        id: chainId,
        name: "custom",
        nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
      },
      transport: http(rpcUrl)
    });

    const taskEscrowAbi = [
      {
        type: "event",
        name: "TaskCreated",
        anonymous: false,
        inputs: [
          { indexed: true, name: "taskId", type: "bytes32" },
          { indexed: true, name: "community", type: "address" },
          { indexed: false, name: "token", type: "address" },
          { indexed: false, name: "reward", type: "uint256" },
          { indexed: false, name: "deadline", type: "uint256" }
        ]
      },
      {
        type: "function",
        name: "getTask",
        stateMutability: "view",
        inputs: [{ name: "taskId", type: "bytes32" }],
        outputs: [
          {
            type: "tuple",
            components: [
              { name: "taskId", type: "bytes32" },
              { name: "community", type: "address" },
              { name: "taskor", type: "address" },
              { name: "supplier", type: "address" },
              { name: "token", type: "address" },
              { name: "reward", type: "uint256" },
              { name: "supplierFee", type: "uint256" },
              { name: "deadline", type: "uint256" },
              { name: "createdAt", type: "uint256" },
              { name: "state", type: "uint8" },
              { name: "metadataUri", type: "string" },
              { name: "evidenceUri", type: "string" },
              { name: "taskType", type: "bytes32" },
              { name: "minJurors", type: "uint256" },
              { name: "juryTaskHash", type: "bytes32" }
            ]
          }
        ]
      },
      {
        type: "function",
        name: "acceptTask",
        stateMutability: "nonpayable",
        inputs: [{ name: "taskId", type: "bytes32" }],
        outputs: []
      },
      {
        type: "function",
        name: "submitEvidence",
        stateMutability: "nonpayable",
        inputs: [
          { name: "taskId", type: "bytes32" },
          { name: "evidenceUri", type: "string" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "linkReceipt",
        stateMutability: "nonpayable",
        inputs: [
          { name: "taskId", type: "bytes32" },
          { name: "receiptId", type: "bytes32" },
          { name: "receiptUri", type: "string" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "assignSupplier",
        stateMutability: "nonpayable",
        inputs: [
          { name: "taskId", type: "bytes32" },
          { name: "supplier", type: "address" },
          { name: "fee", type: "uint256" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "linkJuryValidation",
        stateMutability: "nonpayable",
        inputs: [
          { name: "taskId", type: "bytes32" },
          { name: "juryTaskHash", type: "bytes32" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "completeTask",
        stateMutability: "nonpayable",
        inputs: [{ name: "taskId", type: "bytes32" }],
        outputs: []
      }
    ];

    const sendMode = getArgValue(argv, "--sendMode") ?? process.env.SEND_MODE ?? "eoa";

    const aaConfig =
      sendMode === "aa"
        ? {
            bundlerUrl: getArgValue(argv, "--bundlerUrl") ?? requireEnv("BUNDLER_URL"),
            entryPoint: normalizeHexAddress(
              getArgValue(argv, "--entryPoint") ??
                process.env.ENTRYPOINT_ADDRESS ??
                "0x0000000071727de22e5e9d8baf0edac6f37da032"
            ),
            superPaymaster: normalizeHexAddress(getArgValue(argv, "--paymaster") ?? requireEnv("SUPER_PAYMASTER_ADDRESS")),
            operator: normalizeHexAddress(getArgValue(argv, "--operator") ?? requireEnv("OPERATOR_ADDRESS")),
            aaAccount: normalizeHexAddress(getArgValue(argv, "--aaAccount") ?? requireEnv("AA_ACCOUNT_ADDRESS")),
            paymasterVerificationGas: BigInt(
              getArgValue(argv, "--paymasterVerificationGas") ?? process.env.PAYMASTER_VERIFICATION_GAS ?? "200000"
            ),
            paymasterPostOpGas: BigInt(getArgValue(argv, "--paymasterPostOpGas") ?? process.env.PAYMASTER_POSTOP_GAS ?? "50000"),
            verificationGasLimit: BigInt(getArgValue(argv, "--verificationGasLimit") ?? process.env.VERIFICATION_GAS_LIMIT ?? "150000"),
            callGasLimit: BigInt(getArgValue(argv, "--callGasLimit") ?? process.env.CALL_GAS_LIMIT ?? "200000"),
            preVerificationGas: BigInt(getArgValue(argv, "--preVerificationGas") ?? process.env.PRE_VERIFICATION_GAS ?? "40000"),
            maxPriorityFeePerGas: BigInt(getArgValue(argv, "--maxPriorityFeePerGas") ?? process.env.MAX_PRIORITY_FEE_PER_GAS ?? "2000000000"),
            maxFeePerGas: BigInt(getArgValue(argv, "--maxFeePerGas") ?? process.env.MAX_FEE_PER_GAS ?? "2000000000")
          }
        : null;

    const aaAbi = [
      { type: "function", name: "getNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      {
        type: "function",
        name: "execute",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
        outputs: []
      }
    ];

    const entryPointAbi = [
      {
        type: "function",
        name: "getUserOpHash",
        stateMutability: "view",
        inputs: [
          {
            type: "tuple",
            components: [
              { name: "sender", type: "address" },
              { name: "nonce", type: "uint256" },
              { name: "initCode", type: "bytes" },
              { name: "callData", type: "bytes" },
              { name: "accountGasLimits", type: "bytes32" },
              { name: "preVerificationGas", type: "uint256" },
              { name: "gasFees", type: "bytes32" },
              { name: "paymasterAndData", type: "bytes" },
              { name: "signature", type: "bytes" }
            ]
          }
        ],
        outputs: [{ type: "bytes32" }]
      }
    ];

    const buildUserOp = async ({ to, data, value }) => {
      if (!aaConfig) throw new Error("aaConfig-missing");
      const nonce = await publicClient.readContract({ address: aaConfig.aaAccount, abi: aaAbi, functionName: "getNonce" });
      const callData = encodeFunctionData({ abi: aaAbi, functionName: "execute", args: [to, value ?? 0n, data] });
      const accountGasLimits = concat([
        pad(`0x${aaConfig.verificationGasLimit.toString(16)}`, { dir: "left", size: 16 }),
        pad(`0x${aaConfig.callGasLimit.toString(16)}`, { dir: "left", size: 16 })
      ]);
      const gasFees = concat([
        pad(`0x${aaConfig.maxPriorityFeePerGas.toString(16)}`, { dir: "left", size: 16 }),
        pad(`0x${aaConfig.maxFeePerGas.toString(16)}`, { dir: "left", size: 16 })
      ]);
      const paymasterAndData = concat([
        aaConfig.superPaymaster,
        pad(`0x${aaConfig.paymasterVerificationGas.toString(16)}`, { dir: "left", size: 16 }),
        pad(`0x${aaConfig.paymasterPostOpGas.toString(16)}`, { dir: "left", size: 16 }),
        aaConfig.operator
      ]);
      const userOp = {
        sender: aaConfig.aaAccount,
        nonce,
        initCode: "0x",
        callData,
        accountGasLimits,
        preVerificationGas: aaConfig.preVerificationGas,
        gasFees,
        paymasterAndData,
        signature: "0x"
      };
      const userOpHash = await publicClient.readContract({
        address: aaConfig.entryPoint,
        abi: entryPointAbi,
        functionName: "getUserOpHash",
        args: [userOp]
      });
      userOp.signature = await account.signMessage({ message: { raw: userOpHash } });
      return { userOp, userOpHash, entryPoint: aaConfig.entryPoint };
    };

    const sendUserOp = async ({ to, data, value }) => {
      if (!aaConfig) throw new Error("aaConfig-missing");
      const { userOp, entryPoint } = await buildUserOp({ to, data, value });
      const sentHash = await bundlerRpc(aaConfig.bundlerUrl, "eth_sendUserOperation", [userOp, entryPoint]);
      for (let i = 0; i < 30; i++) {
        const receipt = await bundlerRpc(aaConfig.bundlerUrl, "eth_getUserOperationReceipt", [sentHash]).catch(() => null);
        if (receipt) return { userOpHash: sentHash, receipt };
        await new Promise((r) => setTimeout(r, 500));
      }
      return { userOpHash: sentHash, receipt: null };
    };

    const sendTx = async ({ to, data, wallet, traceId, parentSpanId, name }) => {
      const from = aaConfig ? aaConfig.aaAccount : wallet.account.address;
      return await withSpan(
        { traceId, parentSpanId, name: name ?? (aaConfig ? "aa.sendUserOp" : "evm.sendTx"), to, from, sendMode },
        async () => {
          if (dryRun) {
            logEvent({ event: aaConfig ? "orchestrator.dryRunUserOp" : "orchestrator.dryRunTx", mode, sendMode, to, from, data });
            return null;
          }
          return await withRetries(
            async () => {
              if (aaConfig) {
                const out = await sendUserOp({ to, data, value: 0n });
                return out.userOpHash;
              }
              const hash = await wallet.sendTransaction({ to, data, value: 0n });
              await publicClient.waitForTransactionReceipt({ hash });
              return hash;
            },
            { retries: 2, baseDelayMs: 300, label: "sendTx" }
          );
        }
      );
    };

    const sendTxWithValue = async ({ to, data, wallet, value, traceId, parentSpanId, name }) => {
      const from = aaConfig ? aaConfig.aaAccount : wallet.account.address;
      const valueStr = value?.toString?.() ?? String(value);
      return await withSpan(
        { traceId, parentSpanId, name: name ?? (aaConfig ? "aa.sendUserOp" : "evm.sendTxWithValue"), to, from, value: valueStr, sendMode },
        async () => {
          if (dryRun) {
            logEvent({
              event: aaConfig ? "orchestrator.dryRunUserOp" : "orchestrator.dryRunTx",
              mode,
              sendMode,
              to,
              from,
              data,
              value: valueStr
            });
            return null;
          }
          return await withRetries(
            async () => {
              if (aaConfig) {
                const out = await sendUserOp({ to, data, value: value ?? 0n });
                return out.userOpHash;
              }
              const hash = await wallet.sendTransaction({ to, data, value: value ?? 0n });
              await publicClient.waitForTransactionReceipt({ hash });
              return hash;
            },
            { retries: 2, baseDelayMs: 300, label: "sendTxWithValue" }
          );
        }
      );
    };

    const rpcRequest = async (method, params, { traceId, parentSpanId } = {}) => {
      return await withSpan({ traceId, parentSpanId, name: "evm.rpc", method }, async () => {
        return await publicClient.request({ method, params });
      });
    };

    const x402Pay = async ({ url, method, amount, payerAddress, traceId, parentSpanId }) => {
      if (!x402ProxyUrl) return null;
      return await withSpan(
        { traceId, parentSpanId, name: "x402.pay", url, method, amount: String(amount ?? ""), payerAddress },
        async () => {
          try {
            const receiptUriOut = await withRetries(
              async () => {
                const res = await fetch(`${x402ProxyUrl.replace(/\/$/, "")}/pay`, {
                  method: "POST",
                  headers: { "content-type": "application/json", "x-trace-id": traceId ?? "" },
                  body: JSON.stringify({
                    url,
                    method,
                    amount,
                    currency: x402Currency,
                    payerAddress,
                    agentId: agentId.toString(),
                    chainId: String(chainId),
                    sponsorAddress: x402SponsorAddress,
                    policyId: x402PolicyId,
                    metadata: { mode: "orchestrateTasks" }
                  })
                });
                const json = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(`x402 /pay ${res.status}: ${JSON.stringify(json)}`);
                return json.receiptUri;
              },
              { retries: 2, baseDelayMs: 400, label: "x402Pay" }
            );
            counters.x402PayOk += 1;
            return receiptUriOut;
          } catch (e) {
            counters.x402PayFail += 1;
            throw e;
          }
        }
      );
    };

    const saveState = () => {
      try {
        writeJsonAtomic(stateFile, state);
      } catch (e) {
        logEvent({ event: "orchestrator.stateWriteFailed", ok: false, stateFile, error: String(e) });
      }
    };

    const normalizeTaskForState = (t) => {
      if (!t) return null;
      return {
        taskId: String(t.taskId ?? ""),
        community: String(t.community ?? ""),
        taskor: String(t.taskor ?? ""),
        supplier: String(t.supplier ?? ""),
        token: String(t.token ?? ""),
        reward: (t.reward ?? 0n).toString(),
        supplierFee: (t.supplierFee ?? 0n).toString(),
        deadline: (t.deadline ?? 0n).toString(),
        createdAt: (t.createdAt ?? 0n).toString(),
        state: Number(t.state ?? 0),
        metadataUri: String(t.metadataUri ?? ""),
        evidenceUri: String(t.evidenceUri ?? ""),
        taskType: String(t.taskType ?? ""),
        minJurors: (t.minJurors ?? 0n).toString(),
        juryTaskHash: String(t.juryTaskHash ?? "")
      };
    };

    const taskStateLabel = (n) => {
      const v = Number(n);
      if (v === 0) return "Created";
      if (v === 1) return "Accepted";
      if (v === 2) return "Submitted";
      if (v === 3) return "Validated";
      if (v === 4) return "Completed";
      if (v >= 5) return `Done(${v})`;
      return `State(${v})`;
    };

    const taskCreatedEvent = taskEscrowAbi.find((x) => x?.type === "event" && x?.name === "TaskCreated");
    const taskCreatedTopic0 = keccak256(toHex("TaskCreated(bytes32,address,address,uint256,uint256)"));
    const ingestTaskCreated = (log) => {
      if (!taskCreatedEvent) return null;
      try {
        const decoded = decodeEventLog({ abi: [taskCreatedEvent], data: log.data, topics: log.topics });
        return decoded?.eventName === "TaskCreated" ? decoded.args : null;
      } catch {
        return null;
      }
    };

    const processTask = async ({ taskId, source, blockNumber }) => {
      if (!taskId) return;
      const taskIdKey = String(taskId);
      const traceId = taskIdKey;
      const logTaskEvent = (obj) => logEvent({ traceId, taskId, ...obj });
      state.tasks[taskIdKey] = state.tasks[taskIdKey] ?? { taskId: taskIdKey, attempts: 0, done: false, lastError: null };

      const entry = state.tasks[taskIdKey];
      if (entry.done) return;

      const rootSpan = startSpan({
        traceId,
        name: "orchestrator.processTask",
        taskId: taskIdKey,
        source,
        blockNumber: blockNumber?.toString?.() ?? null
      });
      let rootOk = true;

      counters.tasksProcessed += 1;
      entry.attempts = Number(entry.attempts ?? 0) + 1;
      entry.lastAttemptAt = new Date().toISOString();
      entry.lastSource = source;
      if (blockNumber !== undefined && blockNumber !== null) entry.lastBlockNumber = blockNumber.toString();
      saveState();

      try {
        const task = await withSpan(
          { traceId, parentSpanId: rootSpan.spanId, name: "evm.readContract", to: taskEscrow, functionName: "getTask" },
          async () => {
            return await publicClient.readContract({
              address: taskEscrow,
              abi: taskEscrowAbi,
              functionName: "getTask",
              args: [taskId]
            });
          }
        );

        const status = Number(task.state);
        entry.task = normalizeTaskForState(task);
        entry.lastStatus = status;
        saveState();
        if (status >= 5) {
          entry.lastError = null;
          saveState();
          logTaskEvent({ event: "orchestrator.skipDoneTask", ok: true, mode, status, source });
          if (!myShopItemsAddress || !rewardItemId || entry.rewardTriggered === true) {
            entry.done = true;
            saveState();
            return;
          }
        }

        const shouldAccept = autoAccept && status === 0;
        const shouldSubmit =
          autoSubmit &&
          (status === 1 || status === 2) &&
          String(task.taskor).toLowerCase() === account.address.toLowerCase();

        if (shouldAccept) {
          const data = encodeFunctionData({ abi: taskEscrowAbi, functionName: "acceptTask", args: [taskId] });
          const txHash = await sendTx({ to: taskEscrow, data, wallet: walletClient, traceId, parentSpanId: rootSpan.spanId, name: "task.acceptTask" });
          logTaskEvent({ event: "orchestrator.acceptTask", ok: true, mode, txHash, source });
        }

        if (shouldSubmit) {
          const data = encodeFunctionData({ abi: taskEscrowAbi, functionName: "submitEvidence", args: [taskId, evidenceUri] });
          const txHash = await sendTx({ to: taskEscrow, data, wallet: walletClient, traceId, parentSpanId: rootSpan.spanId, name: "task.submitEvidence" });
          logTaskEvent({ event: "orchestrator.submitEvidence", ok: true, mode, evidenceUri, txHash, source });

          if (!receiptUri && x402ProxyUrl && BigInt(x402TaskAmount) > 0n) {
            try {
              receiptUri = await x402Pay({ url: evidenceUri, method: "EVIDENCE", amount: x402TaskAmount, payerAddress: account.address, traceId, parentSpanId: rootSpan.spanId });
              logTaskEvent({ event: "orchestrator.x402Pay", ok: true, mode, kind: "task", receiptUri });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.x402PayFailed", ok: false, mode, kind: "task", error: String(e) });
            }
          }

          if (receiptUri) {
            const receiptId = deriveReceiptId(receiptUri);
            const linkData = encodeFunctionData({ abi: taskEscrowAbi, functionName: "linkReceipt", args: [taskId, receiptId, receiptUri] });
            try {
              const linkTxHash = await sendTx({ to: taskEscrow, data: linkData, wallet: walletClient, traceId, parentSpanId: rootSpan.spanId, name: "task.linkReceipt" });
              entry.taskReceiptLinked = true;
              entry.taskReceipt = { receiptId, receiptUri, txHash: linkTxHash };
              saveState();
              logTaskEvent({ event: "orchestrator.linkReceipt", ok: true, mode, receiptId, receiptUri, txHash: linkTxHash });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.linkReceiptFailed", ok: false, mode, receiptId, error: String(e) });
            }
          }

          const juryAbi = [
            {
              type: "function",
              name: "validationRequest",
              stateMutability: "nonpayable",
              inputs: [
                { name: "validatorAddress", type: "address" },
                { name: "agentId", type: "uint256" },
                { name: "requestUri", type: "string" },
                { name: "requestHash", type: "bytes32" }
              ],
              outputs: []
            },
            {
              type: "function",
              name: "validationResponse",
              stateMutability: "nonpayable",
              inputs: [
                { name: "requestHash", type: "bytes32" },
                { name: "response", type: "uint8" },
                { name: "responseUri", type: "string" },
                { name: "responseHash", type: "bytes32" },
                { name: "tag", type: "bytes32" }
              ],
              outputs: []
            },
            {
              type: "function",
              name: "linkReceiptToValidation",
              stateMutability: "nonpayable",
              inputs: [
                { name: "requestHash", type: "bytes32" },
                { name: "receiptId", type: "bytes32" },
                { name: "receiptUri", type: "string" }
              ],
              outputs: []
            },
            {
              type: "function",
              name: "getMySBT",
              stateMutability: "view",
              inputs: [],
              outputs: [{ name: "mysbt", type: "address" }]
            },
            {
              type: "function",
              name: "deriveValidationRequestHash",
              stateMutability: "view",
              inputs: [
                { name: "taskId", type: "bytes32" },
                { name: "agentId", type: "uint256" },
                { name: "validatorAddress", type: "address" },
                { name: "tag", type: "bytes32" },
                { name: "requestUri", type: "string" }
              ],
              outputs: [{ name: "requestHash", type: "bytes32" }]
            },
            {
              type: "function",
              name: "getValidationStatus",
              stateMutability: "view",
              inputs: [{ name: "requestHash", type: "bytes32" }],
              outputs: [
                { name: "validatorAddress", type: "address" },
                { name: "agentId", type: "uint256" },
                { name: "response", type: "uint8" },
                { name: "tag", type: "bytes32" },
                { name: "lastUpdate", type: "uint256" }
              ]
            },
            {
              type: "function",
              name: "isActiveJuror",
              stateMutability: "view",
              inputs: [{ name: "juror", type: "address" }],
              outputs: [{ name: "isActive", type: "bool" }, { name: "stake", type: "uint256" }]
            }
          ];

          const mySbtAbi = [
            {
              type: "function",
              name: "ownerOf",
              stateMutability: "view",
              inputs: [{ name: "tokenId", type: "uint256" }],
              outputs: [{ name: "owner", type: "address" }]
            }
          ];

          const validationRequestUri =
            validationRequestUriRaw ??
            buildDataJsonUri({
              schema: "aastar.erc8004.validationRequest@v1",
              chainId: String(chainId),
              taskId,
              agentId: agentId.toString(),
              validatorAddress: juryContractAddress,
              tag: validationTag,
              evidenceUri
            });

          const requestHash =
            getArgValue(argv, "--requestHash") ??
            process.env.VALIDATION_REQUEST_HASH ??
            deriveErc8004RequestHash({
              chainId,
              taskId,
              agentId,
              validatorAddress: juryContractAddress,
              tag: validationTag,
              requestUri: validationRequestUri
            });

          try {
            const expectedOnchain = await publicClient.readContract({
              address: juryContractAddress,
              abi: juryAbi,
              functionName: "deriveValidationRequestHash",
              args: [taskId, agentId, juryContractAddress, validationTag, validationRequestUri]
            });
            if (expectedOnchain !== requestHash) {
              entry.lastError = `requestHash mismatch: local=${requestHash} onchain=${expectedOnchain}`;
              saveState();
              logTaskEvent({
                event: "orchestrator.requestHashMismatch",
                ok: false,
                mode,
                taskId,
                agentId: agentId.toString(),
                requestHash,
                expectedOnchain
              });
              return;
            }
          } catch (e) {
            logTaskEvent({ event: "orchestrator.requestHashCheckUnavailable", ok: true, mode, error: String(e) });
          }

          const validationResponseUri =
            validationResponseUriRaw ??
            buildDataJsonUri({
              schema: "aastar.erc8004.validationResponse@v1",
              chainId: String(chainId),
              taskId,
              agentId: agentId.toString(),
              validatorAddress: validatorAccount.address,
              tag: validationTag,
              response: validationScore,
              requestHash
            });

          entry.requestHash = entry.requestHash ?? requestHash;
          entry.validation = entry.validation ?? {};
          entry.validation.request = {
            schema: "aastar.erc8004.validationRequest@v1",
            chainId: String(chainId),
            taskId,
            agentId: agentId.toString(),
            validatorAddress: juryContractAddress,
            tag: validationTag,
            requestUri: validationRequestUri,
            requestHash
          };
          entry.validation.request.canonical = stableStringify(entry.validation.request);
          saveState();

          if (validationMinCount > 0n) {
            let taskForOwnerCheck = null;
            try {
              taskForOwnerCheck = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
            } catch {}

            let expectedAgentOwner = null;
            if (expectedAgentOwnerRaw === "taskor") expectedAgentOwner = taskForOwnerCheck?.taskor ?? null;
            else if (expectedAgentOwnerRaw === "community") expectedAgentOwner = taskForOwnerCheck?.community ?? null;
            else expectedAgentOwner = normalizeHexAddress(expectedAgentOwnerRaw);

            try {
              const mySbt = await publicClient.readContract({ address: juryContractAddress, abi: juryAbi, functionName: "getMySBT", args: [] });
              if (mySbt && mySbt !== "0x0000000000000000000000000000000000000000") {
                const owner = await publicClient.readContract({ address: mySbt, abi: mySbtAbi, functionName: "ownerOf", args: [agentId] });
                entry.agentOwner = owner;
                entry.agentOwnerSource = "MySBT.ownerOf";
                entry.expectedAgentOwner = expectedAgentOwner;
                saveState();
                if (enforceAgentOwner && expectedAgentOwner && owner.toLowerCase() !== expectedAgentOwner.toLowerCase()) {
                  entry.lastError = `agentId owner mismatch: ownerOf(${agentId.toString()})=${owner} expected=${expectedAgentOwner}`;
                  saveState();
                  logTaskEvent({
                    event: "orchestrator.agentOwnerMismatch",
                    ok: false,
                    mode,
                    agentId: agentId.toString(),
                    agentOwner: owner,
                    expectedAgentOwner
                  });
                  return;
                }
              }
            } catch (e) {
              logTaskEvent({ event: "orchestrator.agentOwnerLookupFailed", ok: false, mode, error: String(e) });
            }

            const statusTuple = await publicClient.readContract({
              address: juryContractAddress,
              abi: juryAbi,
              functionName: "getValidationStatus",
              args: [requestHash]
            });
            const lastUpdate = BigInt(statusTuple?.[4] ?? 0);

            if (entry.validationRequestSent !== true) {
              const reqData = encodeFunctionData({ abi: juryAbi, functionName: "validationRequest", args: [juryContractAddress, agentId, validationRequestUri, requestHash] });
              try {
                const reqTxHash = await sendTx({ to: juryContractAddress, data: reqData, wallet: communityWalletClient, traceId, parentSpanId: rootSpan.spanId, name: "jury.validationRequest" });
                entry.validationRequestSent = true;
                saveState();
                logTaskEvent({ event: "orchestrator.validationRequest", ok: true, mode, requestHash, requestUri: validationRequestUri, txHash: reqTxHash });
              } catch (e) {
                logTaskEvent({ event: "orchestrator.validationRequestFailed", ok: false, mode, requestHash, error: String(e) });
              }
            }

            logEvent({ event: "orchestrator.validationRequestHash", mode, taskId, requestHash });

            if (!validationReceiptUri && x402ProxyUrl && BigInt(x402ValidationAmount) > 0n) {
              try {
                validationReceiptUri = await x402Pay({
                  url: validationRequestUri,
                  method: "VALIDATION",
                  amount: x402ValidationAmount,
                  payerAddress: communityAccount.address,
                  traceId,
                  parentSpanId: rootSpan.spanId
                });
                logEvent({ event: "orchestrator.x402Pay", mode, kind: "validation", receiptUri: validationReceiptUri });
              } catch (e) {
                logEvent({ event: "orchestrator.x402PayFailed", mode, kind: "validation", error: String(e) });
              }
            }

            if (validationReceiptUri) {
              const validationReceiptId = deriveReceiptId(validationReceiptUri);
              const linkValidationReceiptData = encodeFunctionData({
                abi: juryAbi,
                functionName: "linkReceiptToValidation",
                args: [requestHash, validationReceiptId, validationReceiptUri]
              });
              try {
                const linkValidationReceiptTxHash = await sendTx({ to: juryContractAddress, data: linkValidationReceiptData, wallet: communityWalletClient, traceId, parentSpanId: rootSpan.spanId, name: "jury.linkReceiptToValidation" });
                logEvent({ event: "orchestrator.linkReceiptToValidation", mode, requestHash, receiptId: validationReceiptId, receiptUri: validationReceiptUri, txHash: linkValidationReceiptTxHash });
              } catch (e) {
                logEvent({ event: "orchestrator.linkReceiptToValidationFailed", mode, requestHash, error: String(e) });
              }
            }

            if (lastUpdate === 0n) {
              const jurorStatus = await publicClient.readContract({
                address: juryContractAddress,
                abi: juryAbi,
                functionName: "isActiveJuror",
                args: [validatorAccount.address]
              });
              const isActive = Boolean(jurorStatus?.[0]);
              if (!isActive) {
                logEvent({ event: "orchestrator.validatorNotActiveJuror", mode, validator: validatorAccount.address, requestHash });
              } else {
                const respData = encodeFunctionData({
                  abi: juryAbi,
                  functionName: "validationResponse",
                  args: [requestHash, validationScore, validationResponseUri, "0x0000000000000000000000000000000000000000000000000000000000000000", validationTag]
                });
                try {
                  const respTxHash = await sendTx({ to: juryContractAddress, data: respData, wallet: validatorWalletClient, traceId, parentSpanId: rootSpan.spanId, name: "jury.validationResponse" });
                  logEvent({ event: "orchestrator.validationResponse", mode, requestHash, score: validationScore, responseUri: validationResponseUri, tag: validationTag, txHash: respTxHash });
                  entry.validation = entry.validation ?? {};
                  entry.validation.response = {
                    schema: "aastar.erc8004.validationResponse@v1",
                    chainId: String(chainId),
                    taskId,
                    agentId: agentId.toString(),
                    validatorAddress: validatorAccount.address,
                    tag: validationTag,
                    response: Number(validationScore),
                    requestHash,
                    responseUri: validationResponseUri
                  };
                  entry.validation.response.canonical = stableStringify(entry.validation.response);
                  saveState();
                } catch (e) {
                  logEvent({ event: "orchestrator.validationResponseFailed", mode, requestHash, error: String(e) });
                }
              }
            }
          }

          if (autoFinalize) {
            const juryFlowAbi = [
              {
                type: "function",
                name: "submitEvidence",
                stateMutability: "nonpayable",
                inputs: [
                  { name: "taskHash", type: "bytes32" },
                  { name: "evidenceUri", type: "string" }
                ],
                outputs: []
              },
              {
                type: "function",
                name: "vote",
                stateMutability: "nonpayable",
                inputs: [
                  { name: "taskHash", type: "bytes32" },
                  { name: "response", type: "uint8" },
                  { name: "reasoning", type: "string" }
                ],
                outputs: []
              },
              {
                type: "function",
                name: "finalizeTask",
                stateMutability: "nonpayable",
                inputs: [{ name: "taskHash", type: "bytes32" }],
                outputs: []
              },
              {
                type: "function",
                name: "getTask",
                stateMutability: "view",
                inputs: [{ name: "taskHash", type: "bytes32" }],
                outputs: [
                  {
                    type: "tuple",
                    components: [
                      { name: "agentId", type: "uint256" },
                      { name: "taskHash", type: "bytes32" },
                      { name: "evidenceUri", type: "string" },
                      { name: "taskType", type: "uint8" },
                      { name: "reward", type: "uint256" },
                      { name: "deadline", type: "uint256" },
                      { name: "status", type: "uint8" },
                      { name: "minJurors", type: "uint256" },
                      { name: "consensusThreshold", type: "uint256" },
                      { name: "totalVotes", type: "uint256" },
                      { name: "positiveVotes", type: "uint256" },
                      { name: "finalResponse", type: "uint8" }
                    ]
                  }
                ]
              }
            ];

            try {
              const submitEvidenceData = encodeFunctionData({
                abi: juryFlowAbi,
                functionName: "submitEvidence",
                args: [requestHash, validationRequestUri]
              });
              const subTxHash = await sendTx({ to: juryContractAddress, data: submitEvidenceData, wallet: communityWalletClient, traceId, parentSpanId: rootSpan.spanId, name: "juryFlow.submitEvidence" });
              logTaskEvent({ event: "orchestrator.jurySubmitEvidence", ok: true, mode, requestHash, txHash: subTxHash });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.jurySubmitEvidenceFailed", ok: false, mode, requestHash, error: String(e) });
            }

            try {
              const voteData = encodeFunctionData({
                abi: juryFlowAbi,
                functionName: "vote",
                args: [requestHash, validationScore, validationResponseUri]
              });
              const voteTxHash = await sendTx({ to: juryContractAddress, data: voteData, wallet: validatorWalletClient, traceId, parentSpanId: rootSpan.spanId, name: "juryFlow.vote" });
              logTaskEvent({ event: "orchestrator.juryVote", ok: true, mode, requestHash, score: validationScore, txHash: voteTxHash });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.juryVoteFailed", ok: false, mode, requestHash, error: String(e) });
            }

            let juryTask = null;
            try {
              juryTask = await publicClient.readContract({ address: juryContractAddress, abi: juryFlowAbi, functionName: "getTask", args: [requestHash] });
            } catch {}

            if (autoFastForward && juryTask?.deadline) {
              try {
                const latestBlock = await publicClient.getBlock();
                const now = BigInt(latestBlock.timestamp);
                const deadline = BigInt(juryTask.deadline);
                if (deadline > 0n && deadline >= now) {
                  const delta = deadline - now + 2n;
                  await rpcRequest("evm_increaseTime", [Number(delta)], { traceId, parentSpanId: rootSpan.spanId });
                  await rpcRequest("evm_mine", [], { traceId, parentSpanId: rootSpan.spanId });
                  logTaskEvent({ event: "orchestrator.fastForward", ok: true, mode, seconds: Number(delta) });
                }
              } catch (e) {
                logTaskEvent({ event: "orchestrator.fastForwardFailed", ok: false, mode, error: String(e) });
              }
            }

            try {
              const finalizeJuryData = encodeFunctionData({ abi: juryFlowAbi, functionName: "finalizeTask", args: [requestHash] });
              const finalizeJuryTxHash = await sendTx({ to: juryContractAddress, data: finalizeJuryData, wallet: walletClient, traceId, parentSpanId: rootSpan.spanId, name: "juryFlow.finalizeTask" });
              logTaskEvent({ event: "orchestrator.juryFinalize", ok: true, mode, requestHash, txHash: finalizeJuryTxHash });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.juryFinalizeFailed", ok: false, mode, requestHash, error: String(e) });
            }

            try {
              const refreshedTask = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
              const refreshedStatus = Number(refreshedTask.state);
              if (refreshedStatus === 3) {
                const linkData = encodeFunctionData({ abi: taskEscrowAbi, functionName: "linkJuryValidation", args: [taskId, requestHash] });
                const linkTxHash = await sendTx({ to: taskEscrow, data: linkData, wallet: walletClient, traceId, parentSpanId: rootSpan.spanId, name: "task.linkJuryValidation" });
                logTaskEvent({ event: "orchestrator.linkJuryValidation", ok: true, mode, requestHash, txHash: linkTxHash });
              }
            } catch (e) {
              logTaskEvent({ event: "orchestrator.linkJuryValidationFailed", ok: false, mode, requestHash, error: String(e) });
            }

            try {
              const refreshedTask2 = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
              const refreshedStatus2 = Number(refreshedTask2.state);
              if (refreshedStatus2 === 4) {
                const completeData = encodeFunctionData({ abi: taskEscrowAbi, functionName: "completeTask", args: [taskId] });
                const completeTxHash = await sendTx({ to: taskEscrow, data: completeData, wallet: walletClient, traceId, parentSpanId: rootSpan.spanId, name: "task.completeTask" });
                logTaskEvent({ event: "orchestrator.completeTask", ok: true, mode, txHash: completeTxHash });
              }
            } catch (e) {
              logTaskEvent({ event: "orchestrator.completeTaskFailed", ok: false, mode, error: String(e) });
            }
          }
        }

        const finalTask = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
        const finalStatus = Number(finalTask.state);

        if (myShopItemsAddress && rewardItemId && entry.rewardTriggered !== true && finalStatus >= 5) {
          const myShopItemsAbi = [
            {
              type: "function",
              name: "buy",
              stateMutability: "payable",
              inputs: [
                { name: "itemId", type: "uint256" },
                { name: "quantity", type: "uint256" },
                { name: "recipient", type: "address" },
                { name: "extraData", type: "bytes" }
              ],
              outputs: [{ name: "firstTokenId", type: "uint256" }]
            }
          ];

          const extraData =
            rewardExtraDataHexRaw && rewardExtraDataHexRaw.startsWith("0x")
              ? rewardExtraDataHexRaw
              : rewardExtraDataHexRaw
                ? `0x${rewardExtraDataHexRaw}`
                : encodeAbiParameters(
                    [{ name: "taskId", type: "bytes32" }, { name: "juryTaskHash", type: "bytes32" }],
                    [taskId, finalTask.juryTaskHash]
                  );

          const rewardData = encodeFunctionData({
            abi: myShopItemsAbi,
            functionName: "buy",
            args: [rewardItemId, rewardQuantity, finalTask.taskor, extraData]
          });

          entry.rewardAttemptedAt = new Date().toISOString();
          saveState();
          try {
            const rewardTxHash = await sendTxWithValue({
              to: myShopItemsAddress,
              data: rewardData,
              wallet: walletClient,
              value: rewardValue,
              traceId,
              parentSpanId: rootSpan.spanId,
              name: "reward.buy"
            });
            entry.rewardTriggered = true;
            entry.rewardTxHash = rewardTxHash;
            saveState();
            logTaskEvent({
              event: "orchestrator.rewardTriggered",
              ok: true,
              mode,
              myShopItemsAddress,
              itemId: rewardItemId.toString(),
              quantity: rewardQuantity.toString(),
              recipient: finalTask.taskor,
              value: rewardValue.toString(),
              txHash: rewardTxHash
            });
            counters.rewardsTriggered += 1;
          } catch (e) {
            entry.rewardTriggered = false;
            entry.rewardError = String(e);
            saveState();
            logTaskEvent({ event: "orchestrator.rewardFailed", ok: false, mode, error: String(e) });
            counters.rewardsFailed += 1;
          }
        }

        if (finalStatus >= 5 || requireManualFinalize) {
          entry.done = true;
        }
        entry.lastError = null;
        entry.lastStatus = finalStatus;
        saveState();
      } catch (e) {
        rootOk = false;
        entry.lastError = String(e);
        saveState();
        logTaskEvent({ event: "orchestrator.taskFailed", ok: false, mode, source, error: String(e) });
        counters.tasksFailed += 1;
      } finally {
        endSpan({ traceId, spanId: rootSpan.spanId, name: "orchestrator.processTask", startedAtMs: rootSpan.startedAtMs, ok: rootOk });
      }
    };

    if (scanOnStart) {
      try {
        const latestBlock = await publicClient.getBlockNumber();
        const fromBlock = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;
        const chunkSize = BigInt(getArgValue(argv, "--scanChunkSize") ?? process.env.ORCH_SCAN_CHUNK_SIZE ?? "2000");
        for (let start = fromBlock; start <= latestBlock; start += chunkSize) {
          const end = start + chunkSize - 1n <= latestBlock ? start + chunkSize - 1n : latestBlock;
          const logs = await publicClient.getLogs({ address: taskEscrow, topics: [taskCreatedTopic0], fromBlock: start, toBlock: end });
          for (const log of logs) {
            const args = ingestTaskCreated(log);
            if (!args?.taskId) continue;
            await processTask({ taskId: args.taskId, source: "startupScan", blockNumber: log.blockNumber });
          }
        }
        state.lastScanToBlock = latestBlock.toString();
        saveState();
        logEvent({ event: "orchestrator.startupScan", ok: true, fromBlock: fromBlock.toString(), toBlock: latestBlock.toString() });
        if (exitAfterScan) {
          logEvent({ event: "orchestrator.exitAfterScan", ok: true });
          process.exit(0);
        }
      } catch (e) {
        logEvent({ event: "orchestrator.startupScanFailed", ok: false, error: String(e) });
      }
    }

    let unwatch = () => {};
    unwatch = publicClient.watchContractEvent({
      address: taskEscrow,
      abi: taskEscrowAbi,
      eventName: "TaskCreated",
      onLogs: async (logs) => {
        for (const log of logs) {
          const args = log.args ?? {};
          const taskId = args.taskId;
          if (!taskId) continue;
          await processTask({ taskId, source: "watch", blockNumber: log.blockNumber });

          if (once) {
            unwatch();
            process.exit(0);
          }
        }
      }
    });

    return;
  }

  if (
    mode !== "linkJuryValidation" &&
    mode !== "linkReceipt" &&
    mode !== "linkValidationReceipt" &&
    mode !== "linkReceiptToValidation"
  ) {
    throw new Error(`Unsupported mode: ${mode}`);
  }

  const bundlerUrl = getArgValue(argv, "--bundlerUrl") ?? requireEnv("BUNDLER_URL");
  const privateKeyRaw =
    getArgValue(argv, "--privateKey") ??
    process.env.PRIVATE_KEY ??
    (dryRun ? `0x${"1".padStart(64, "0")}` : requireEnv("PRIVATE_KEY"));
  const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
  const superPaymaster = getArgValue(argv, "--paymaster") ?? requireEnv("SUPER_PAYMASTER_ADDRESS");
  const operator = getArgValue(argv, "--operator") ?? requireEnv("OPERATOR_ADDRESS");
  const aaAccount = getArgValue(argv, "--aaAccount") ?? requireEnv("AA_ACCOUNT_ADDRESS");

  const taskId = mode === "linkValidationReceipt" ? undefined : getArgValue(argv, "--taskId") ?? requireEnv("TASK_ID");
  const juryTaskHash =
    mode === "linkJuryValidation" ? getArgValue(argv, "--juryTaskHash") ?? requireEnv("JURY_TASK_HASH") : undefined;
  const requestHash =
    mode === "linkValidationReceipt" || mode === "linkReceiptToValidation"
      ? getArgValue(argv, "--requestHash") ?? requireEnv("VALIDATION_REQUEST_HASH")
      : undefined;
  const juryContractAddress =
    mode === "linkValidationReceipt" || mode === "linkReceiptToValidation"
      ? getArgValue(argv, "--juryContract") ?? requireEnv("JURY_CONTRACT_ADDRESS")
      : undefined;
  const receiptUri =
    mode === "linkReceipt" || mode === "linkValidationReceipt" || mode === "linkReceiptToValidation"
      ? getArgValue(argv, "--receiptUri") ?? requireEnv("RECEIPT_URI")
      : undefined;
  const receiptIdRaw =
    mode === "linkReceipt" || mode === "linkValidationReceipt" || mode === "linkReceiptToValidation"
      ? getArgValue(argv, "--receiptId") ?? process.env.RECEIPT_ID
      : undefined;
  const receiptId =
    mode === "linkReceipt" || mode === "linkValidationReceipt" || mode === "linkReceiptToValidation"
      ? receiptIdRaw
        ? receiptIdRaw.startsWith("0x")
          ? receiptIdRaw
          : `0x${receiptIdRaw}`
        : deriveReceiptId(receiptUri)
      : undefined;

  const paymasterVerificationGas = BigInt(getArgValue(argv, "--paymasterVerificationGas") ?? process.env.PAYMASTER_VERIFICATION_GAS ?? "200000");
  const paymasterPostOpGas = BigInt(getArgValue(argv, "--paymasterPostOpGas") ?? process.env.PAYMASTER_POSTOP_GAS ?? "50000");

  const verificationGasLimit = BigInt(getArgValue(argv, "--verificationGasLimit") ?? process.env.VERIFICATION_GAS_LIMIT ?? "150000");
  const callGasLimit = BigInt(getArgValue(argv, "--callGasLimit") ?? process.env.CALL_GAS_LIMIT ?? "200000");
  const preVerificationGas = BigInt(getArgValue(argv, "--preVerificationGas") ?? process.env.PRE_VERIFICATION_GAS ?? "40000");

  const maxPriorityFeePerGas = BigInt(getArgValue(argv, "--maxPriorityFeePerGas") ?? process.env.MAX_PRIORITY_FEE_PER_GAS ?? "2000000000");
  const maxFeePerGas = BigInt(getArgValue(argv, "--maxFeePerGas") ?? process.env.MAX_FEE_PER_GAS ?? "2000000000");

  const account = privateKeyToAccount(privateKey);

  const aaAbi = [
    { type: "function", name: "getNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }], outputs: [] }
  ];

  const taskEscrowAbi = [
    { type: "function", name: "linkJuryValidation", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] },
    {
      type: "function",
      name: "linkReceipt",
      stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "string" }],
      outputs: []
    }
  ];
  const juryAbi = [
    {
      type: "function",
      name: "linkReceiptToValidation",
      stateMutability: "nonpayable",
      inputs: [{ type: "bytes32" }, { type: "bytes32" }, { type: "string" }],
      outputs: []
    }
  ];

  const entryPointAbi = [
    {
      type: "function",
      name: "getUserOpHash",
      stateMutability: "view",
      inputs: [
        {
          type: "tuple",
          components: [
            { name: "sender", type: "address" },
            { name: "nonce", type: "uint256" },
            { name: "initCode", type: "bytes" },
            { name: "callData", type: "bytes" },
            { name: "accountGasLimits", type: "bytes32" },
            { name: "preVerificationGas", type: "uint256" },
            { name: "gasFees", type: "bytes32" },
            { name: "paymasterAndData", type: "bytes" },
            { name: "signature", type: "bytes" }
          ]
        }
      ],
      outputs: [{ type: "bytes32" }]
    }
  ];

  const nonce = await publicClient.readContract({ address: aaAccount, abi: aaAbi, functionName: "getNonce" });

  const linkData =
    mode === "linkJuryValidation"
      ? encodeFunctionData({
          abi: taskEscrowAbi,
          functionName: "linkJuryValidation",
          args: [taskId, juryTaskHash]
        })
      : mode === "linkReceipt"
        ? encodeFunctionData({
            abi: taskEscrowAbi,
            functionName: "linkReceipt",
            args: [taskId, receiptId, receiptUri]
          })
        : encodeFunctionData({
            abi: juryAbi,
            functionName: "linkReceiptToValidation",
            args: [requestHash, receiptId, receiptUri]
          });

  const target = mode === "linkValidationReceipt" || mode === "linkReceiptToValidation" ? juryContractAddress : taskEscrow;
  const callData = encodeFunctionData({
    abi: aaAbi,
    functionName: "execute",
    args: [target, 0n, linkData]
  });

  const accountGasLimits = concat([
    pad(`0x${verificationGasLimit.toString(16)}`, { dir: "left", size: 16 }),
    pad(`0x${callGasLimit.toString(16)}`, { dir: "left", size: 16 })
  ]);

  const gasFees = concat([
    pad(`0x${maxPriorityFeePerGas.toString(16)}`, { dir: "left", size: 16 }),
    pad(`0x${maxFeePerGas.toString(16)}`, { dir: "left", size: 16 })
  ]);

  const paymasterAndData = concat([
    superPaymaster,
    pad(`0x${paymasterVerificationGas.toString(16)}`, { dir: "left", size: 16 }),
    pad(`0x${paymasterPostOpGas.toString(16)}`, { dir: "left", size: 16 }),
    operator
  ]);

  const userOp = {
    sender: aaAccount,
    nonce,
    initCode: "0x",
    callData,
    accountGasLimits,
    preVerificationGas,
    gasFees,
    paymasterAndData,
    signature: "0x"
  };

  const userOpHash = await publicClient.readContract({
    address: entryPoint,
    abi: entryPointAbi,
    functionName: "getUserOpHash",
    args: [userOp]
  });

  userOp.signature = await account.signMessage({ message: { raw: userOpHash } });

  if (dryRun) {
    process.stdout.write(JSON.stringify({ entryPoint, userOpHash, userOp }, null, 2) + "\n");
    return;
  }

  const sentHash = await bundlerRpc(bundlerUrl, "eth_sendUserOperation", [userOp, entryPoint]);
  process.stdout.write(JSON.stringify({ userOpHash: sentHash }, null, 2) + "\n");

  const receipt = await bundlerRpc(bundlerUrl, "eth_getUserOperationReceipt", [sentHash]);
  if (receipt) process.stdout.write(JSON.stringify({ receipt }, null, 2) + "\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
