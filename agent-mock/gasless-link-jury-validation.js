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

function randomId() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
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

async function main() {
  const argv = process.argv.slice(2);

  const mode = getArgValue(argv, "--mode") ?? process.env.MODE ?? "linkJuryValidation";

  const dryRun = parseBool(getArgValue(argv, "--dryRun"), true);

  const rpcUrl = getArgValue(argv, "--rpcUrl") ?? requireEnv("RPC_URL");

  const chainId = Number(getArgValue(argv, "--chainId") ?? process.env.CHAIN_ID ?? "1");

  const runId = getArgValue(argv, "--runId") ?? process.env.RUN_ID ?? randomId();
  LOG_FILE = getArgValue(argv, "--logFile") ?? process.env.ORCHESTRATOR_LOG_FILE ?? null;
  LOG_MAX_BYTES = Number(getArgValue(argv, "--logMaxBytes") ?? process.env.ORCHESTRATOR_LOG_MAX_BYTES ?? "0");
  LOG_BASE_FIELDS = { service: "orchestrator", mode, runId };

  const entryPoint = getArgValue(argv, "--entryPoint") ??
    process.env.ENTRYPOINT_ADDRESS ??
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

  const taskEscrow = getArgValue(argv, "--taskEscrow") ?? requireEnv("TASK_ESCROW_ADDRESS");

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
        const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const p = u.pathname;
        if (req.method === "GET" && p === "/health") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200 });
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
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200 });
          return sendJson(res, 200, summary);
        }
        if (req.method === "GET" && p === "/state") {
          logEvent({ event: "orchestrator.http", ok: true, traceId, method: req.method, path: p, code: 200 });
          return sendJson(res, 200, { ok: true, state });
        }
        logEvent({ event: "orchestrator.http", ok: false, traceId, method: req.method, path: p, code: 404 });
        return sendJson(res, 404, { error: "not-found" });
      });
      server.listen(apiPort, () => logEvent({ event: "orchestrator.serve", ok: true, port: apiPort }));
    }
    const evidenceUri =
      getArgValue(argv, "--evidenceUri") ??
      process.env.EVIDENCE_URI ??
      "ipfs://evidence";
    let receiptUri = getArgValue(argv, "--receiptUri") ?? process.env.RECEIPT_URI;

    const privateKeyRaw = getArgValue(argv, "--privateKey") ?? requireEnv("PRIVATE_KEY");
    const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
    const account = privateKeyToAccount(privateKey);

    const communityPrivateKeyRaw = getArgValue(argv, "--communityPrivateKey") ?? process.env.COMMUNITY_PRIVATE_KEY;
    const communityAccount = communityPrivateKeyRaw
      ? privateKeyToAccount(communityPrivateKeyRaw.startsWith("0x") ? communityPrivateKeyRaw : `0x${communityPrivateKeyRaw}`)
      : account;

    const validatorPrivateKeyRaw = getArgValue(argv, "--validatorPrivateKey") ?? process.env.VALIDATOR_PRIVATE_KEY;
    const validatorAccount = validatorPrivateKeyRaw
      ? privateKeyToAccount(validatorPrivateKeyRaw.startsWith("0x") ? validatorPrivateKeyRaw : `0x${validatorPrivateKeyRaw}`)
      : account;

    const juryContractAddress =
      getArgValue(argv, "--juryContract") ?? process.env.JURY_CONTRACT_ADDRESS ?? requireEnv("JURY_CONTRACT_ADDRESS");
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
    const validationRequestUri =
      getArgValue(argv, "--validationRequestUri") ??
      process.env.VALIDATION_REQUEST_URI ??
      "ipfs://validation-request";
    const validationResponseUri =
      getArgValue(argv, "--validationResponseUri") ??
      process.env.VALIDATION_RESPONSE_URI ??
      "ipfs://validation-response";
    const validationScore = Number(getArgValue(argv, "--validationScore") ?? process.env.VALIDATION_SCORE ?? "80");
    let validationReceiptUri = getArgValue(argv, "--validationReceiptUri") ?? process.env.VALIDATION_RECEIPT_URI;

    const x402ProxyUrl = getArgValue(argv, "--x402ProxyUrl") ?? process.env.X402_PROXY_URL;
    const x402Currency = getArgValue(argv, "--x402Currency") ?? process.env.X402_CURRENCY ?? "USD";
    const x402TaskAmount = getArgValue(argv, "--x402TaskAmount") ?? process.env.X402_TASK_AMOUNT ?? "0";
    const x402ValidationAmount = getArgValue(argv, "--x402ValidationAmount") ?? process.env.X402_VALIDATION_AMOUNT ?? "0";
    const x402SponsorAddress = getArgValue(argv, "--x402Sponsor") ?? process.env.X402_SPONSOR_ADDRESS ?? null;
    const x402PolicyId = getArgValue(argv, "--x402PolicyId") ?? process.env.X402_POLICY_ID ?? "default";

    const myShopItemsAddress = getArgValue(argv, "--myShopItems") ?? process.env.MYSHOP_ITEMS_ADDRESS ?? null;
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
          { indexed: false, name: "reward", type: "uint256" }
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
              { name: "challengeDeadline", type: "uint256" },
              { name: "challengeStake", type: "uint256" },
              { name: "status", type: "uint8" },
              { name: "metadataUri", type: "string" },
              { name: "evidenceUri", type: "string" },
              { name: "taskType", type: "bytes32" },
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
        name: "submitWork",
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
        name: "setTaskValidationRequirementWithValidators",
        stateMutability: "nonpayable",
        inputs: [
          { name: "taskId", type: "bytes32" },
          { name: "tag", type: "bytes32" },
          { name: "minCount", type: "uint64" },
          { name: "minAvgResponse", type: "uint8" },
          { name: "minUniqueValidators", type: "uint8" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "addTaskValidationRequest",
        stateMutability: "nonpayable",
        inputs: [
          { name: "taskId", type: "bytes32" },
          { name: "requestHash", type: "bytes32" }
        ],
        outputs: []
      },
      {
        type: "function",
        name: "finalizeTask",
        stateMutability: "nonpayable",
        inputs: [{ name: "taskId", type: "bytes32" }],
        outputs: []
      },
      {
        type: "function",
        name: "validationsSatisfied",
        stateMutability: "view",
        inputs: [{ name: "taskId", type: "bytes32" }],
        outputs: [{ type: "bool" }]
      }
    ];

    const sendTx = async ({ to, data, wallet }) => {
      const from = wallet.account.address;
      if (dryRun) {
        logEvent({ event: "orchestrator.dryRunTx", mode, to, from, data });
        return null;
      }
      return await withRetries(
        async () => {
          const hash = await wallet.sendTransaction({ to, data, value: 0n });
          await publicClient.waitForTransactionReceipt({ hash });
          return hash;
        },
        { retries: 2, baseDelayMs: 300, label: "sendTx" }
      );
    };

    const sendTxWithValue = async ({ to, data, wallet, value }) => {
      const from = wallet.account.address;
      if (dryRun) {
        logEvent({ event: "orchestrator.dryRunTx", mode, to, from, data, value: value?.toString?.() ?? String(value) });
        return null;
      }
      return await withRetries(
        async () => {
          const hash = await wallet.sendTransaction({ to, data, value: value ?? 0n });
          await publicClient.waitForTransactionReceipt({ hash });
          return hash;
        },
        { retries: 2, baseDelayMs: 300, label: "sendTxWithValue" }
      );
    };

    const rpcRequest = async (method, params) => {
      return await publicClient.request({ method, params });
    };

    const x402Pay = async ({ url, method, amount, payerAddress, traceId }) => {
      if (!x402ProxyUrl) return null;
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
    };

    const saveState = () => {
      try {
        writeJsonAtomic(stateFile, state);
      } catch (e) {
        logEvent({ event: "orchestrator.stateWriteFailed", ok: false, stateFile, error: String(e) });
      }
    };

    const taskCreatedEvent = taskEscrowAbi.find((x) => x?.type === "event" && x?.name === "TaskCreated");
    const taskCreatedTopic0 = keccak256(toHex("TaskCreated(bytes32,address,address,uint256)"));
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

      counters.tasksProcessed += 1;
      entry.attempts = Number(entry.attempts ?? 0) + 1;
      entry.lastAttemptAt = new Date().toISOString();
      entry.lastSource = source;
      if (blockNumber !== undefined && blockNumber !== null) entry.lastBlockNumber = blockNumber.toString();
      saveState();

      try {
        const task = await publicClient.readContract({
          address: taskEscrow,
          abi: taskEscrowAbi,
          functionName: "getTask",
          args: [taskId]
        });

        const status = Number(task.status);
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
          const txHash = await sendTx({ to: taskEscrow, data, wallet: walletClient });
          logTaskEvent({ event: "orchestrator.acceptTask", ok: true, mode, txHash, source });
        }

        if (shouldSubmit) {
          const data = encodeFunctionData({ abi: taskEscrowAbi, functionName: "submitWork", args: [taskId, evidenceUri] });
          const txHash = await sendTx({ to: taskEscrow, data, wallet: walletClient });
          logTaskEvent({ event: "orchestrator.submitWork", ok: true, mode, evidenceUri, txHash, source });

          if (!receiptUri && x402ProxyUrl && BigInt(x402TaskAmount) > 0n) {
            try {
              receiptUri = await x402Pay({ url: evidenceUri, method: "EVIDENCE", amount: x402TaskAmount, payerAddress: account.address, traceId });
              logTaskEvent({ event: "orchestrator.x402Pay", ok: true, mode, kind: "task", receiptUri });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.x402PayFailed", ok: false, mode, kind: "task", error: String(e) });
            }
          }

          if (receiptUri) {
            const receiptId = keccak256(toHex(receiptUri));
            const linkReceiptData = encodeFunctionData({ abi: taskEscrowAbi, functionName: "linkReceipt", args: [taskId, receiptId, receiptUri] });
            const linkReceiptTxHash = await sendTx({ to: taskEscrow, data: linkReceiptData, wallet: walletClient });
            logTaskEvent({ event: "orchestrator.linkReceipt", ok: true, mode, receiptId, receiptUri, txHash: linkReceiptTxHash });
          }

          if (validationMinCount > 0n && String(task.community).toLowerCase() === communityAccount.address.toLowerCase()) {
            const setReqData = encodeFunctionData({
              abi: taskEscrowAbi,
              functionName: "setTaskValidationRequirementWithValidators",
              args: [taskId, validationTag, validationMinCount, validationMinAvg, validationMinUnique]
            });
            const setReqTxHash = await sendTx({ to: taskEscrow, data: setReqData, wallet: communityWalletClient });
            logTaskEvent({
              event: "orchestrator.setTaskValidationRequirementWithValidators",
              ok: true,
              mode,
              tag: validationTag,
              minCount: validationMinCount.toString(),
              minAvg: validationMinAvg,
              minUnique: validationMinUnique,
              txHash: setReqTxHash
            });
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

          const requestHash =
            getArgValue(argv, "--requestHash") ??
            process.env.VALIDATION_REQUEST_HASH ??
            keccak256(toHex(`${taskId}:${validationTag}:${validationRequestUri}`));

          entry.requestHash = entry.requestHash ?? requestHash;
          saveState();

          if (validationMinCount > 0n) {
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
                const reqTxHash = await sendTx({ to: juryContractAddress, data: reqData, wallet: communityWalletClient });
                entry.validationRequestSent = true;
                saveState();
                logTaskEvent({ event: "orchestrator.validationRequest", ok: true, mode, requestHash, requestUri: validationRequestUri, txHash: reqTxHash });
              } catch (e) {
                logTaskEvent({ event: "orchestrator.validationRequestFailed", ok: false, mode, requestHash, error: String(e) });
              }
            }

            const addReqData = encodeFunctionData({ abi: taskEscrowAbi, functionName: "addTaskValidationRequest", args: [taskId, requestHash] });
            try {
              const addReqTxHash = await sendTx({ to: taskEscrow, data: addReqData, wallet: walletClient });
              logEvent({ event: "orchestrator.addTaskValidationRequest", mode, taskId, requestHash, txHash: addReqTxHash });
            } catch (e) {
              logEvent({ event: "orchestrator.addTaskValidationRequestFailed", mode, taskId, requestHash, error: String(e) });
            }

            if (!validationReceiptUri && x402ProxyUrl && BigInt(x402ValidationAmount) > 0n) {
              try {
                validationReceiptUri = await x402Pay({
                  url: validationRequestUri,
                  method: "VALIDATION",
                  amount: x402ValidationAmount,
                  payerAddress: communityAccount.address,
                  traceId
                });
                logEvent({ event: "orchestrator.x402Pay", mode, kind: "validation", receiptUri: validationReceiptUri });
              } catch (e) {
                logEvent({ event: "orchestrator.x402PayFailed", mode, kind: "validation", error: String(e) });
              }
            }

            if (validationReceiptUri) {
              const validationReceiptId = keccak256(toHex(validationReceiptUri));
              const linkValidationReceiptData = encodeFunctionData({
                abi: juryAbi,
                functionName: "linkReceiptToValidation",
                args: [requestHash, validationReceiptId, validationReceiptUri]
              });
              try {
                const linkValidationReceiptTxHash = await sendTx({ to: juryContractAddress, data: linkValidationReceiptData, wallet: communityWalletClient });
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
                  const respTxHash = await sendTx({ to: juryContractAddress, data: respData, wallet: validatorWalletClient });
                  logEvent({ event: "orchestrator.validationResponse", mode, requestHash, score: validationScore, responseUri: validationResponseUri, tag: validationTag, txHash: respTxHash });
                } catch (e) {
                  logEvent({ event: "orchestrator.validationResponseFailed", mode, requestHash, error: String(e) });
                }
              }
            }
          }

          if (autoFinalize) {
            const refreshed = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
            const challengeDeadline = BigInt(refreshed.challengeDeadline);
            const latestBlock = await publicClient.getBlock();
            const now = BigInt(latestBlock.timestamp);

            if (autoFastForward && challengeDeadline > 0n && challengeDeadline > now) {
              const delta = challengeDeadline - now + 2n;
              try {
                await rpcRequest("evm_increaseTime", [Number(delta)]);
                await rpcRequest("evm_mine", []);
                logTaskEvent({ event: "orchestrator.fastForward", ok: true, mode, seconds: Number(delta) });
              } catch (e) {
                logTaskEvent({ event: "orchestrator.fastForwardFailed", ok: false, mode, error: String(e) });
              }
            }

            if (requireManualFinalize) {
              let satisfied = null;
              try {
                satisfied = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "validationsSatisfied", args: [taskId] });
              } catch {}
              logTaskEvent({ event: "orchestrator.manualFinalizeRequired", ok: true, mode, challengeDeadline: refreshed.challengeDeadline, validationsSatisfied: satisfied });
              return;
            }

            const finalizeData = encodeFunctionData({ abi: taskEscrowAbi, functionName: "finalizeTask", args: [taskId] });
            try {
              const finalizeTxHash = await sendTx({ to: taskEscrow, data: finalizeData, wallet: walletClient });
              logTaskEvent({ event: "orchestrator.finalizeTask", ok: true, mode, txHash: finalizeTxHash });
            } catch (e) {
              logTaskEvent({ event: "orchestrator.finalizeFailed", ok: false, mode, error: String(e) });
            }
          }
        }

        const finalTask = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
        const finalStatus = Number(finalTask.status);

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
              value: rewardValue
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
        entry.lastError = String(e);
        saveState();
        logTaskEvent({ event: "orchestrator.taskFailed", ok: false, mode, source, error: String(e) });
        counters.tasksFailed += 1;
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
  const privateKeyRaw = getArgValue(argv, "--privateKey") ?? requireEnv("PRIVATE_KEY");
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
        : keccak256(toHex(receiptUri))
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
