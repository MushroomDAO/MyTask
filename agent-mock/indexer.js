#!/usr/bin/env node
const nodeHttp = require("http");
const fs = require("fs");
const path = require("path");
const { createPublicClient, http, decodeAbiParameters, decodeEventLog, keccak256, toHex } = require("viem");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
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

function _tryParseArtifactJson(uri) {
  if (!uri) return null;
  const raw = String(uri).trim();
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

function buildArtifactInfo(uri) {
  const payload = _tryParseArtifactJson(uri);
  if (payload == null) return null;
  const canonical = stableStringify(payload);
  const digest = keccak256(toHex(canonical));
  return { digest, canonical, payload };
}

function jsonStringifySafe(value, space) {
  return JSON.stringify(value, (key, v) => (typeof v === "bigint" ? v.toString() : v), space);
}

function buildReputationSnapshotFromFinalState(finalState, agentId) {
  const agentKey = String(agentId);
  const agent = finalState.agents?.[agentKey];
  if (!agent) return null;

  const validations = [];
  for (const taskId of Object.keys(finalState.tasks ?? {})) {
    const t = finalState.tasks[taskId];
    const vals = t?.validations ?? [];
    for (const v of vals) {
      if (String(v?.agentId ?? "") !== agentKey) continue;
      validations.push({ taskId, ...v });
    }
  }
  validations.sort((a, b) => Number(BigInt(b.lastUpdate ?? "0") - BigInt(a.lastUpdate ?? "0")));

  const payload = {
    schema: "aastar.agentReputation@v1",
    chainId: String(finalState.meta.chainId),
    juryContract: finalState.meta.juryContract,
    generatedAt: finalState.meta.generatedAt,
    agentId: agentKey,
    owner: agent.owner ?? null,
    ownerSource: agent.ownerSource ?? null,
    byTag: agent.byTag ?? {},
    byValidator: agent.byValidator ?? {},
    byTagWindow: agent.byTagWindow ?? null,
    validations
  };
  const canonical = stableStringify(payload);
  const digest = keccak256(toHex(canonical));
  return { digest, canonical, reputation: payload };
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

function createLogger({ baseFields, logFile, logMaxBytes }) {
  return (obj) => {
    const lineObj = { ts: new Date().toISOString(), ...baseFields, ...obj };
    try {
      process.stdout.write(JSON.stringify(lineObj) + "\n");
    } catch {}
    if (!logFile) return;
    try {
      rotateLogIfNeeded(logFile, logMaxBytes);
      fs.appendFileSync(logFile, JSON.stringify(lineObj) + "\n");
    } catch {}
  };
}

function readJsonRecovering(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    try {
      if (fs.existsSync(filePath)) {
        fs.renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
      }
    } catch {}
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  atomicWriteFile(filePath, JSON.stringify(obj, null, 2));
}

function sendJson(res, code, obj) {
  const body = jsonStringifySafe(obj);
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

function toNumberSafe(v) {
  if (typeof v === "bigint") return Number(v);
  return Number(v);
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

async function main() {
  const argv = process.argv.slice(2);
  const rpcUrl = getArgValue(argv, "--rpcUrl") ?? process.env.RPC_URL ?? requireEnv("RPC_URL");
  const chainId = Number(getArgValue(argv, "--chainId") ?? process.env.CHAIN_ID ?? "1");
  const serve = parseBool(getArgValue(argv, "--serve") ?? process.env.INDEXER_SERVE, false);
  const port = Number(getArgValue(argv, "--port") ?? process.env.INDEXER_PORT ?? "8790");
  const taskEscrow = normalizeHexAddress(
    getArgValue(argv, "--taskEscrow") ?? process.env.TASK_ESCROW_ADDRESS ?? requireEnv("TASK_ESCROW_ADDRESS")
  );
  const juryContract = normalizeHexAddress(
    getArgValue(argv, "--juryContract") ?? process.env.JURY_CONTRACT_ADDRESS ?? requireEnv("JURY_CONTRACT_ADDRESS")
  );
  const rewardAction = normalizeHexAddress(
    getArgValue(argv, "--rewardAction") ?? process.env.REWARD_ACTION_ADDRESS ?? null
  );

  const outFile =
    getArgValue(argv, "--out") ?? process.env.INDEXER_OUT ?? path.join(process.cwd(), "out", "index.json");
  const outDir = path.dirname(outFile);
  ensureDir(outDir);

  const writeReputationSnapshots = parseBool(
    getArgValue(argv, "--writeReputationSnapshots") ?? process.env.INDEXER_WRITE_REPUTATION_SNAPSHOTS,
    false
  );
  const reputationOutDir =
    getArgValue(argv, "--reputationOutDir") ?? process.env.INDEXER_REPUTATION_OUT_DIR ?? outDir;
  const tagWindowDays = Number(getArgValue(argv, "--tagWindowDays") ?? process.env.INDEXER_TAG_WINDOW_DAYS ?? "30");
  const agentMock = parseBool(getArgValue(argv, "--agentMock") ?? process.env.INDEXER_AGENT_MOCK, false);
  const agentMockStoreFile =
    getArgValue(argv, "--agentMockStore") ??
    process.env.INDEXER_AGENT_MOCK_STORE ??
    path.join(outDir, "agent-mock-store.json");

  const cursorFile =
    getArgValue(argv, "--cursorFile") ??
    process.env.INDEXER_CURSOR_FILE ??
    path.join(process.cwd(), "out", "indexer-cursor.json");
  ensureDir(path.dirname(cursorFile));
  const resume = parseBool(getArgValue(argv, "--resume") ?? process.env.INDEXER_RESUME, true);
  const confirmations = BigInt(getArgValue(argv, "--confirmations") ?? process.env.INDEXER_CONFIRMATIONS ?? "0");
  const chunkSize = BigInt(getArgValue(argv, "--chunkSize") ?? process.env.INDEXER_CHUNK_SIZE ?? "2000");

  const runId = getArgValue(argv, "--runId") ?? process.env.RUN_ID ?? randomId();
  const logFile = getArgValue(argv, "--logFile") ?? process.env.INDEXER_LOG_FILE ?? null;
  const logMaxBytes = Number(getArgValue(argv, "--logMaxBytes") ?? process.env.INDEXER_LOG_MAX_BYTES ?? "0");
  const logEvent = createLogger({ baseFields: { service: "indexer", runId }, logFile, logMaxBytes });

  const publicClient = createPublicClient({
    chain: { id: chainId, name: "custom", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl)
  });

  const fromBlockArg = getArgValue(argv, "--fromBlock") ?? process.env.FROM_BLOCK;
  const toBlockArg = getArgValue(argv, "--toBlock") ?? process.env.TO_BLOCK;
  const latestBlock = await publicClient.getBlockNumber();
  const safeToBlock = latestBlock > confirmations ? latestBlock - confirmations : 0n;
  const cursor = resume ? readJsonRecovering(cursorFile, { lastProcessedBlock: "0" }) : { lastProcessedBlock: "0" };
  const resumeFromBlock =
    cursor?.lastProcessedBlock !== undefined ? BigInt(cursor.lastProcessedBlock) + 1n : 0n;
  const fromBlock = fromBlockArg
    ? BigInt(fromBlockArg)
    : resume
      ? resumeFromBlock
      : safeToBlock > 5000n
        ? safeToBlock - 5000n
        : 0n;
  const toBlockRaw = toBlockArg ? BigInt(toBlockArg) : safeToBlock;
  const toBlock = toBlockRaw <= safeToBlock ? toBlockRaw : safeToBlock;

  logEvent({
    event: "indexer.start",
    ok: true,
    chainId,
    taskEscrow,
    juryContract,
    rewardAction,
    fromBlock: fromBlock.toString(),
    toBlock: toBlock.toString(),
    latestBlock: latestBlock.toString(),
    confirmations: confirmations.toString(),
    chunkSize: chunkSize.toString(),
    cursorFile,
    resume
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
      type: "event",
      name: "TaskAccepted",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: true, name: "taskor", type: "address" },
        { indexed: false, name: "timestamp", type: "uint256" }
      ]
    },
    {
      type: "event",
      name: "EvidenceSubmitted",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: false, name: "evidenceUri", type: "string" },
        { indexed: false, name: "timestamp", type: "uint256" }
      ]
    },
    {
      type: "event",
      name: "TaskValidated",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: true, name: "juryTaskHash", type: "bytes32" },
        { indexed: false, name: "finalResponse", type: "uint8" }
      ]
    },
    {
      type: "event",
      name: "TaskCompleted",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: false, name: "taskorPayout", type: "uint256" },
        { indexed: false, name: "supplierPayout", type: "uint256" },
        { indexed: false, name: "juryPayout", type: "uint256" }
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
  ];

  const juryAbi = [
    {
      type: "event",
      name: "ValidationRequest",
      anonymous: false,
      inputs: [
        { indexed: true, name: "validatorAddress", type: "address" },
        { indexed: true, name: "agentId", type: "uint256" },
        { indexed: false, name: "requestUri", type: "string" },
        { indexed: true, name: "requestHash", type: "bytes32" }
      ]
    },
    {
      type: "event",
      name: "ValidationResponse",
      anonymous: false,
      inputs: [
        { indexed: true, name: "validatorAddress", type: "address" },
        { indexed: true, name: "agentId", type: "uint256" },
        { indexed: true, name: "requestHash", type: "bytes32" },
        { indexed: false, name: "response", type: "uint8" },
        { indexed: false, name: "responseUri", type: "string" },
        { indexed: false, name: "tag", type: "bytes32" }
      ]
    },
    {
      type: "event",
      name: "ValidationReceiptLinked",
      anonymous: false,
      inputs: [
        { indexed: true, name: "requestHash", type: "bytes32" },
        { indexed: true, name: "receiptId", type: "bytes32" },
        { indexed: false, name: "receiptUri", type: "string" },
        { indexed: true, name: "linker", type: "address" }
      ]
    },
    {
      type: "function",
      name: "getValidationStatus",
      stateMutability: "view",
      inputs: [{ type: "bytes32" }],
      outputs: [
        { name: "validatorAddress", type: "address" },
        { name: "agentId", type: "uint256" },
        { name: "response", type: "uint8" },
        { name: "tag", type: "bytes32" },
        { name: "lastUpdate", type: "uint256" }
      ]
    },
    { type: "function", name: "getValidationReceipts", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32[]" }] },
    { type: "function", name: "getMySBT", stateMutability: "view", inputs: [], outputs: [{ name: "mysbt", type: "address" }] }
  ];

  const mySbtAbi = [
    { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] }
  ];

  const state = {
    meta: {
      chainId,
      rpcUrl,
      taskEscrow,
      juryContract,
      rewardAction,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      confirmations: confirmations.toString(),
      cursorFile,
      resume,
      latestBlock: latestBlock.toString(),
      generatedAt: new Date().toISOString()
    },
    tasks: {},
    receipts: {},
    validations: {},
    agents: {},
    rewards: [],
    alerts: []
  };

  const ingestEvent = (abi, log) => {
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
      return { name: decoded.eventName, args: decoded.args };
    } catch {
      return null;
    }
  };

  const ingestTaskEscrowLog = (log) => {
    const decoded = ingestEvent(taskEscrowAbi, log);
    if (!decoded) return;
    if (
      decoded.name === "TaskCreated" ||
      decoded.name === "TaskAccepted" ||
      decoded.name === "EvidenceSubmitted" ||
      decoded.name === "TaskValidated" ||
      decoded.name === "TaskCompleted"
    ) {
      const taskId = decoded.args.taskId;
      state.tasks[taskId] = state.tasks[taskId] ?? { taskId, events: [] };
      state.tasks[taskId].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
      if (decoded.name === "TaskValidated" && decoded.args.juryTaskHash) {
        state.tasks[taskId].juryTaskHash = decoded.args.juryTaskHash;
      }
    }
  };

  const ingestJuryLog = (log) => {
    const decoded = ingestEvent(juryAbi, log);
    if (!decoded) return;
    if (decoded.name === "ValidationRequest" || decoded.name === "ValidationResponse") {
      const requestHash = decoded.args.requestHash;
      state.validations[requestHash] = state.validations[requestHash] ?? { requestHash, events: [] };
      state.validations[requestHash].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
      return;
    }
    if (decoded.name === "ValidationReceiptLinked") {
      const requestHash = decoded.args.requestHash;
      const receiptId = decoded.args.receiptId;
      state.validations[requestHash] = state.validations[requestHash] ?? { requestHash, events: [] };
      state.validations[requestHash].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
      state.receipts[receiptId] = state.receipts[receiptId] ?? { receiptId, links: [] };
      state.receipts[receiptId].links.push({ kind: "validation", requestHash, receiptUri: decoded.args.receiptUri, linker: decoded.args.linker });
    }
  };

  const getValidationArtifacts = (requestHash) => {
    const v = state.validations[requestHash];
    if (!v || !Array.isArray(v.events)) return { requestUri: null, responseUri: null, requestArtifact: null, responseArtifact: null };
    let requestUri = null;
    let responseUri = null;
    for (const e of v.events) {
      if (e?.name === "ValidationRequest" && e?.args?.requestUri) requestUri = e.args.requestUri;
      if (e?.name === "ValidationResponse" && e?.args?.responseUri) responseUri = e.args.responseUri;
    }
    return { requestUri, responseUri, requestArtifact: buildArtifactInfo(requestUri), responseArtifact: buildArtifactInfo(responseUri) };
  };

  const rewardActionAbi = [
    {
      type: "event",
      name: "ActionEvent",
      anonymous: false,
      inputs: [
        { indexed: true, name: "buyer", type: "address" },
        { indexed: true, name: "recipient", type: "address" },
        { indexed: true, name: "itemId", type: "uint256" },
        { indexed: false, name: "shopId", type: "uint256" },
        { indexed: false, name: "quantity", type: "uint256" },
        { indexed: false, name: "actionData", type: "bytes" },
        { indexed: false, name: "extraData", type: "bytes" }
      ]
    }
  ];

  const ingestRewardActionLog = (log) => {
    const decoded = ingestEvent(rewardActionAbi, log);
    if (!decoded || decoded.name !== "ActionEvent") return;
    const extraData = decoded.args.extraData;
    let taskId = null;
    let juryTaskHash = null;
    try {
      const parsed = decodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }], extraData);
      taskId = parsed[0];
      juryTaskHash = parsed[1];
    } catch {}

    const reward = {
      txHash: log.transactionHash,
      logIndex: toNumberSafe(log.logIndex),
      blockNumber: toNumberSafe(log.blockNumber),
      buyer: decoded.args.buyer,
      recipient: decoded.args.recipient,
      itemId: decoded.args.itemId?.toString?.() ?? String(decoded.args.itemId),
      shopId: decoded.args.shopId?.toString?.() ?? String(decoded.args.shopId),
      quantity: decoded.args.quantity?.toString?.() ?? String(decoded.args.quantity),
      taskId,
      juryTaskHash,
      extraData
    };
    state.rewards.push(reward);
    if (taskId) {
      state.tasks[taskId] = state.tasks[taskId] ?? { taskId, events: [] };
      state.tasks[taskId].rewards = state.tasks[taskId].rewards ?? [];
      state.tasks[taskId].rewards.push(reward);
    }
  };

  if (fromBlock <= toBlock) {
    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = start + chunkSize - 1n <= toBlock ? start + chunkSize - 1n : toBlock;
      logEvent({ event: "indexer.scanChunk", ok: true, fromBlock: start.toString(), toBlock: end.toString() });
      const taskChunk = await publicClient.getLogs({ address: taskEscrow, fromBlock: start, toBlock: end });
      for (const log of taskChunk) ingestTaskEscrowLog(log);
      const juryChunk = await publicClient.getLogs({ address: juryContract, fromBlock: start, toBlock: end });
      for (const log of juryChunk) ingestJuryLog(log);
      if (rewardAction) {
        const rewardChunk = await publicClient.getLogs({ address: rewardAction, fromBlock: start, toBlock: end });
        for (const log of rewardChunk) ingestRewardActionLog(log);
      }
    }
  }

  const nowBlock = await publicClient.getBlock();
  const now = BigInt(nowBlock.timestamp);

  const taskIds = Object.keys(state.tasks);
  for (const taskId of taskIds) {
    const task = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });

    state.tasks[taskId].onchain = {
      community: task.community,
      taskor: task.taskor,
      supplier: task.supplier,
      token: task.token,
      reward: task.reward.toString(),
      supplierFee: task.supplierFee.toString(),
      deadline: task.deadline.toString(),
      createdAt: task.createdAt.toString(),
      state: Number(task.state),
      metadataUri: task.metadataUri,
      evidenceUri: task.evidenceUri,
      taskType: task.taskType,
      juryTaskHash: task.juryTaskHash,
    };

    const perTaskValidations = [];
    const juryTaskHash = task.juryTaskHash && task.juryTaskHash !== "0x0000000000000000000000000000000000000000000000000000000000000000" ? task.juryTaskHash : null;
    if (juryTaskHash) {
      const requestHash = juryTaskHash;
      const status = await publicClient.readContract({
        address: juryContract,
        abi: juryAbi,
        functionName: "getValidationStatus",
        args: [requestHash]
      });
      const validationReceipts = await publicClient.readContract({
        address: juryContract,
        abi: juryAbi,
        functionName: "getValidationReceipts",
        args: [requestHash]
      });
      const artifacts = getValidationArtifacts(requestHash);
      perTaskValidations.push({
        requestHash,
        validatorAddress: status[0],
        agentId: status[1].toString(),
        response: status[2],
        tag: status[3],
        lastUpdate: status[4].toString(),
        requestUri: artifacts.requestUri,
        responseUri: artifacts.responseUri,
        requestArtifact: artifacts.requestArtifact,
        responseArtifact: artifacts.responseArtifact,
        receipts: validationReceipts
      });

      const agentId = status[1].toString();
      state.agents[agentId] = state.agents[agentId] ?? { agentId, byTag: {}, byValidator: {} };

      const tag = status[3];
      if (status[4] !== 0n) {
        const byTag = state.agents[agentId].byTag[tag] ?? { count: 0, total: 0 };
        byTag.count += 1;
        byTag.total += status[2];
        state.agents[agentId].byTag[tag] = byTag;

        const v = status[0].toLowerCase();
        const byValidator = state.agents[agentId].byValidator[v] ?? { count: 0, total: 0 };
        byValidator.count += 1;
        byValidator.total += status[2];
        state.agents[agentId].byValidator[v] = byValidator;
      }
    }
    state.tasks[taskId].validations = perTaskValidations;
  }

  for (const agentId of Object.keys(state.agents)) {
    const byTag = state.agents[agentId].byTag;
    for (const tag of Object.keys(byTag)) {
      const v = byTag[tag];
      byTag[tag] = { count: v.count, avg: v.count > 0 ? Math.floor(v.total / v.count) : 0 };
    }
    const byValidator = state.agents[agentId].byValidator;
    for (const validator of Object.keys(byValidator)) {
      const v = byValidator[validator];
      byValidator[validator] = { count: v.count, avg: v.count > 0 ? Math.floor(v.total / v.count) : 0 };
    }
  }

  const tagWindowDaysSafe = Number.isFinite(tagWindowDays) ? Math.max(0, Math.floor(tagWindowDays)) : 30;
  if (tagWindowDaysSafe > 0) {
    const cutoff = now > BigInt(tagWindowDaysSafe) * 86400n ? now - BigInt(tagWindowDaysSafe) * 86400n : 0n;
    const windowTotals = {};
    for (const taskId of Object.keys(state.tasks)) {
      const t = state.tasks[taskId];
      const vals = t?.validations ?? [];
      for (const v of vals) {
        const lastUpdate = BigInt(v?.lastUpdate ?? "0");
        if (lastUpdate === 0n || lastUpdate < cutoff) continue;
        const agentId = String(v.agentId);
        const tag = v.tag;
        windowTotals[agentId] = windowTotals[agentId] ?? {};
        const cur = windowTotals[agentId][tag] ?? { count: 0, total: 0 };
        cur.count += 1;
        cur.total += Number(v.response ?? 0);
        windowTotals[agentId][tag] = cur;
      }
    }

    for (const agentId of Object.keys(state.agents)) {
      const totalsByTag = windowTotals[agentId] ?? {};
      const byTagWindow = {};
      for (const tag of Object.keys(totalsByTag)) {
        const v = totalsByTag[tag];
        byTagWindow[tag] = { count: v.count, avg: v.count > 0 ? Math.floor(v.total / v.count) : 0 };
      }
      state.agents[agentId].byTagWindow = {
        windowDays: tagWindowDaysSafe,
        since: cutoff.toString(),
        byTag: byTagWindow
      };
    }
  }

  try {
    const mySbt = await publicClient.readContract({ address: juryContract, abi: juryAbi, functionName: "getMySBT", args: [] });
    if (mySbt && mySbt !== "0x0000000000000000000000000000000000000000") {
      for (const agentId of Object.keys(state.agents)) {
        try {
          const owner = await publicClient.readContract({ address: mySbt, abi: mySbtAbi, functionName: "ownerOf", args: [BigInt(agentId)] });
          state.agents[agentId].owner = owner;
          state.agents[agentId].ownerSource = "MySBT.ownerOf";
        } catch {}
      }
    }
  } catch {}

  const bytes = toHex(jsonStringifySafe(state, 2));
  const digest = keccak256(bytes);
  const finalState = { digest, ...state };
  atomicWriteFile(outFile, jsonStringifySafe(finalState, 2));
  if (writeReputationSnapshots) {
    ensureDir(reputationOutDir);
    for (const agentId of Object.keys(finalState.agents ?? {})) {
      const snapshot = buildReputationSnapshotFromFinalState(finalState, agentId);
      if (!snapshot) continue;
      const filePath = path.join(reputationOutDir, `reputation-${agentId}.json`);
      atomicWriteFile(filePath, jsonStringifySafe(snapshot, 2));
    }
  }
  if (toBlock >= 0n) {
    writeJsonAtomic(cursorFile, { lastProcessedBlock: toBlock.toString(), updatedAt: new Date().toISOString() });
  }

  const summary = {
    outFile,
    digest,
    tasks: Object.keys(state.tasks).length,
    validations: Object.keys(state.validations).length,
    agents: Object.keys(state.agents).length,
    rewards: state.rewards.length,
    alerts: state.alerts.length
  };
  process.stdout.write(JSON.stringify(summary) + "\n");
  logEvent({ event: "indexer.done", ok: true, ...summary, cursorFile, lastProcessedBlock: toBlock.toString() });

  if (!serve) return;

  let agentMockStore = null;
  if (agentMock) {
    ensureDir(path.dirname(agentMockStoreFile));
    agentMockStore = readJsonRecovering(agentMockStoreFile, { version: 1, order: [], requests: {} });
    agentMockStore.order = Array.isArray(agentMockStore.order) ? agentMockStore.order : [];
    agentMockStore.requests = agentMockStore.requests && typeof agentMockStore.requests === "object" ? agentMockStore.requests : {};
  }

  const saveAgentMockStore = () => {
    if (!agentMockStore) return;
    writeJsonAtomic(agentMockStoreFile, agentMockStore);
  };

  const rememberAgentMockResponse = (key, entry) => {
    if (!agentMockStore) return;
    if (agentMockStore.requests[key]) return agentMockStore.requests[key];
    agentMockStore.requests[key] = entry;
    agentMockStore.order.push(key);
    while (agentMockStore.order.length > 1000) {
      const oldKey = agentMockStore.order.shift();
      if (oldKey) delete agentMockStore.requests[oldKey];
    }
    saveAgentMockStore();
    return entry;
  };

  const flattenValidations = () => {
    const all = [];
    for (const taskId of Object.keys(finalState.tasks)) {
      const t = finalState.tasks[taskId];
      const vals = t.validations ?? [];
      for (const v of vals) {
        all.push({ taskId, ...v });
      }
    }
    all.sort((a, b) => Number(BigInt(b.lastUpdate ?? "0") - BigInt(a.lastUpdate ?? "0")));
    return all;
  };

  const listTasks = () => {
    const arr = Object.keys(finalState.tasks).map((taskId) => {
      const t = finalState.tasks[taskId] ?? {};
      const onchain = t.onchain ?? {};
      const rewards = t.rewards ?? [];
      return {
        taskId,
        status: onchain.status ?? null,
        community: onchain.community ?? null,
        taskor: onchain.taskor ?? null,
        supplier: onchain.supplier ?? null,
        reward: onchain.reward ?? null,
        createdAt: onchain.createdAt ?? null,
        deadline: onchain.deadline ?? null,
        challengeDeadline: onchain.challengeDeadline ?? null,
        validationsSatisfied: onchain.validationsSatisfied ?? null,
        rewardCount: rewards.length,
        metadataUri: onchain.metadataUri ?? null,
        evidenceUri: onchain.evidenceUri ?? null
      };
    });
    arr.sort((a, b) => Number(BigInt(b.createdAt ?? "0") - BigInt(a.createdAt ?? "0")));
    return arr;
  };

  const server = nodeHttp.createServer(async (req, res) => {
    const traceId = req.headers["x-trace-id"] ? String(req.headers["x-trace-id"]) : randomId();
    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = u.pathname;

    if (agentMock && req.method === "POST" && p.startsWith("/agent/")) {
      let bodyRaw = "";
      try {
        bodyRaw = await readBody(req, 64 * 1024);
      } catch (e) {
        logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 413, error: String(e) });
        return sendJson(res, 413, { error: "body-too-large" });
      }

      let body = null;
      try {
        body = bodyRaw ? JSON.parse(bodyRaw) : {};
      } catch {
        logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 400 });
        return sendJson(res, 400, { error: "invalid-json" });
      }

      const idempotencyKey = keccak256(toHex(stableStringify({ path: p, body })));
      const cached = agentMockStore?.requests?.[idempotencyKey];
      if (cached?.response) {
        logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200, cached: true });
        return sendJson(res, 200, cached.response);
      }

      const receivedAt = new Date().toISOString();
      let response = null;

      if (p === "/agent/tasks/onCreated") {
        response = { ok: true, accepted: true, agentTaskId: body?.taskId ? `agent-${body.taskId}` : `agent-${randomId()}` };
      } else if (p === "/agent/tasks/onEvidenceSubmitted") {
        response = { ok: true, juryTaskHash: null };
      } else if (p === "/agent/jury/assign") {
        const candidateJurors = Array.isArray(body?.candidateJurors) ? body.candidateJurors : [];
        const minJurors = Number(body?.minJurors ?? 0);
        const selectedJurors = candidateJurors.slice(0, Math.max(0, Math.floor(minJurors)));
        const juryTaskHash = keccak256(toHex(stableStringify({ taskId: body?.taskId ?? null, selectedJurors, runId })));
        response = { ok: true, selectedJurors, juryTaskHash };
      } else if (p === "/agent/jury/result") {
        response = { ok: true, txHash: null };
      } else if (p === "/agent/reward/trigger") {
        response = { ok: true, txHash: null };
      } else {
        logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 404 });
        return sendJson(res, 404, { error: "not-found" });
      }

      rememberAgentMockResponse(idempotencyKey, { receivedAt, path: p, request: body, response });
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200, agentMock: true });
      return sendJson(res, 200, response);
    }

    if (req.method === "GET" && p === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/metrics") {
      const cursorNow = readJsonRecovering(cursorFile, { lastProcessedBlock: "0" });
      const metrics = {
        ok: true,
        service: "indexer",
        runId,
        digest: finalState.digest,
        latestBlock: finalState.meta.latestBlock,
        safeToBlock: finalState.meta.toBlock,
        cursorFile,
        lastProcessedBlock: cursorNow.lastProcessedBlock ?? "0",
        tasks: Object.keys(finalState.tasks).length,
        validations: Object.keys(finalState.validations).length,
        agents: Object.keys(finalState.agents).length,
        rewards: finalState.rewards?.length ?? 0,
        alerts: finalState.alerts.length
      };
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, metrics);
    }

    if (req.method === "GET" && p === "/state") {
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, finalState);
    }

    if (req.method === "GET" && p === "/alerts") {
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, alerts: finalState.alerts });
    }

    if (req.method === "GET" && p === "/tasks") {
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, tasks: listTasks() });
    }

    if (req.method === "GET" && p.startsWith("/tasks/")) {
      const taskId = p.split("/").pop();
      const task = finalState.tasks[taskId];
      if (!task) {
        logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 404 });
        return sendJson(res, 404, { error: "not-found" });
      }
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, task });
    }

    if (req.method === "GET" && p === "/validations") {
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, validations: flattenValidations() });
    }

    if (req.method === "GET" && p === "/rewards") {
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, rewards: finalState.rewards ?? [] });
    }

    if (req.method === "GET" && p.startsWith("/agents/")) {
      const agentId = p.split("/").pop();
      const agent = finalState.agents[agentId];
      if (!agent) {
        logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 404 });
        return sendJson(res, 404, { error: "not-found" });
      }
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, agent });
    }

    if (req.method === "GET" && p === "/agents") {
      const agents = Object.keys(finalState.agents)
        .map((agentId) => ({ agentId, ...finalState.agents[agentId] }))
        .sort((a, b) => Number(BigInt(b.agentId) - BigInt(a.agentId)));
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, agents });
    }

    if (req.method === "GET" && p.startsWith("/reputation/")) {
      const agentId = p.split("/").pop();
      const snapshot = buildReputationSnapshotFromFinalState(finalState, agentId);
      if (!snapshot) {
        logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 404 });
        return sendJson(res, 404, { error: "not-found" });
      }
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, ...snapshot });
    }

    if (req.method === "GET" && p === "/reputation") {
      const agents = Object.keys(finalState.agents)
        .sort((a, b) => Number(BigInt(b) - BigInt(a)))
        .map((agentId) => ({
          agentId,
          owner: finalState.agents[agentId]?.owner ?? null,
          ownerSource: finalState.agents[agentId]?.ownerSource ?? null,
          href: `/reputation/${agentId}`
        }));
      logEvent({ event: "indexer.http", ok: true, traceId, method: req.method, path: p, code: 200 });
      return sendJson(res, 200, { ok: true, agents });
    }

    if (req.method === "GET" && p === "/") {
      const tasks = listTasks().slice(0, 20);
      const taskLinks = tasks
        .map((t) => `<li><a href="/tasks/${escapeHtml(t.taskId)}">${escapeHtml(t.taskId)}</a> status=${escapeHtml(t.status)}</li>`)
        .join("");

      const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MyTask indexer</title>
  </head>
  <body>
    <h1>MyTask indexer</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/tasks">/tasks</a></li>
      <li><a href="/validations">/validations</a></li>
      <li><a href="/rewards">/rewards</a></li>
      <li><a href="/agents">/agents</a></li>
      <li><a href="/reputation">/reputation</a></li>
      <li><a href="/alerts">/alerts</a></li>
      <li><a href="/state">/state</a></li>
    </ul>
    <h2>Summary</h2>
    <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
    <h2>Latest tasks</h2>
    <ol>${taskLinks || "<li>(none)</li>"}</ol>
  </body>
</html>`;
      return sendHtml(res, 200, html);
    }

    logEvent({ event: "indexer.http", ok: false, traceId, method: req.method, path: p, code: 404 });
    return sendJson(res, 404, { error: "not-found" });
  });

  server.listen(port, () => {
    logEvent({ event: "indexer.serve", ok: true, port });
    process.stdout.write(JSON.stringify({ ok: true, serve: true, port }) + "\n");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
