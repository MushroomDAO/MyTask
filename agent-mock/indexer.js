#!/usr/bin/env node
const nodeHttp = require("http");
const fs = require("fs");
const path = require("path");
const { createPublicClient, http, decodeEventLog, keccak256, toHex } = require("viem");
require("dotenv").config({ path: path.join(process.cwd(), ".env") });

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
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
  return v.startsWith("0x") ? v : `0x${v}`;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
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

function toNumberSafe(v) {
  if (typeof v === "bigint") return Number(v);
  return Number(v);
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

  const outFile =
    getArgValue(argv, "--out") ?? process.env.INDEXER_OUT ?? path.join(process.cwd(), "out", "index.json");
  const outDir = path.dirname(outFile);
  ensureDir(outDir);

  const publicClient = createPublicClient({
    chain: { id: chainId, name: "custom", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl)
  });

  const latestBlock = await publicClient.getBlockNumber();
  const fromBlockArg = getArgValue(argv, "--fromBlock") ?? process.env.FROM_BLOCK;
  const toBlockArg = getArgValue(argv, "--toBlock") ?? process.env.TO_BLOCK;
  const fromBlock = fromBlockArg ? BigInt(fromBlockArg) : latestBlock > 5000n ? latestBlock - 5000n : 0n;
  const toBlock = toBlockArg ? BigInt(toBlockArg) : latestBlock;

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
      type: "event",
      name: "WorkSubmitted",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: false, name: "evidenceUri", type: "string" },
        { indexed: false, name: "challengeDeadline", type: "uint256" }
      ]
    },
    {
      type: "event",
      name: "TaskFinalized",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: false, name: "taskorPayout", type: "uint256" },
        { indexed: false, name: "supplierPayout", type: "uint256" },
        { indexed: false, name: "juryPayout", type: "uint256" }
      ]
    },
    {
      type: "event",
      name: "ReceiptLinked",
      anonymous: false,
      inputs: [
        { indexed: true, name: "taskId", type: "bytes32" },
        { indexed: true, name: "receiptId", type: "bytes32" },
        { indexed: false, name: "receiptUri", type: "string" },
        { indexed: true, name: "linker", type: "address" }
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
    { type: "function", name: "getTaskReceipts", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32[]" }] },
    { type: "function", name: "getTaskValidationRequests", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32[]" }] },
    { type: "function", name: "getTaskRequiredValidationTags", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32[]" }] },
    {
      type: "function",
      name: "getTaskValidationRequirement",
      stateMutability: "view",
      inputs: [{ type: "bytes32" }, { type: "bytes32" }],
      outputs: [
        { name: "minCount", type: "uint64" },
        { name: "minAvgResponse", type: "uint8" },
        { name: "minUniqueValidators", type: "uint8" },
        { name: "enabled", type: "bool" }
      ]
    },
    { type: "function", name: "validationsSatisfied", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] }
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
    { type: "function", name: "getValidationReceipts", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bytes32[]" }] }
  ];

  const taskLogs = await publicClient.getLogs({ address: taskEscrow, fromBlock, toBlock });
  const juryLogs = await publicClient.getLogs({ address: juryContract, fromBlock, toBlock });

  const state = {
    meta: {
      chainId,
      rpcUrl,
      taskEscrow,
      juryContract,
      fromBlock: fromBlock.toString(),
      toBlock: toBlock.toString(),
      generatedAt: new Date().toISOString()
    },
    tasks: {},
    receipts: {},
    validations: {},
    agents: {},
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

  for (const log of taskLogs) {
    const decoded = ingestEvent(taskEscrowAbi, log);
    if (!decoded) continue;
    if (decoded.name === "TaskCreated") {
      const taskId = decoded.args.taskId;
      state.tasks[taskId] = state.tasks[taskId] ?? { taskId, events: [] };
      state.tasks[taskId].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
    }
    if (decoded.name === "WorkSubmitted") {
      const taskId = decoded.args.taskId;
      state.tasks[taskId] = state.tasks[taskId] ?? { taskId, events: [] };
      state.tasks[taskId].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
    }
    if (decoded.name === "TaskFinalized") {
      const taskId = decoded.args.taskId;
      state.tasks[taskId] = state.tasks[taskId] ?? { taskId, events: [] };
      state.tasks[taskId].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
    }
    if (decoded.name === "ReceiptLinked") {
      const taskId = decoded.args.taskId;
      const receiptId = decoded.args.receiptId;
      state.tasks[taskId] = state.tasks[taskId] ?? { taskId, events: [] };
      state.tasks[taskId].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
      state.receipts[receiptId] = state.receipts[receiptId] ?? { receiptId, links: [] };
      state.receipts[receiptId].links.push({ kind: "task", taskId, receiptUri: decoded.args.receiptUri, linker: decoded.args.linker });
    }
  }

  for (const log of juryLogs) {
    const decoded = ingestEvent(juryAbi, log);
    if (!decoded) continue;
    if (decoded.name === "ValidationRequest") {
      const requestHash = decoded.args.requestHash;
      state.validations[requestHash] = state.validations[requestHash] ?? { requestHash, events: [] };
      state.validations[requestHash].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
    }
    if (decoded.name === "ValidationResponse") {
      const requestHash = decoded.args.requestHash;
      state.validations[requestHash] = state.validations[requestHash] ?? { requestHash, events: [] };
      state.validations[requestHash].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
    }
    if (decoded.name === "ValidationReceiptLinked") {
      const requestHash = decoded.args.requestHash;
      const receiptId = decoded.args.receiptId;
      state.validations[requestHash] = state.validations[requestHash] ?? { requestHash, events: [] };
      state.validations[requestHash].events.push({ name: decoded.name, blockNumber: toNumberSafe(log.blockNumber), args: decoded.args });
      state.receipts[receiptId] = state.receipts[receiptId] ?? { receiptId, links: [] };
      state.receipts[receiptId].links.push({ kind: "validation", requestHash, receiptUri: decoded.args.receiptUri, linker: decoded.args.linker });
    }
  }

  const nowBlock = await publicClient.getBlock();
  const now = BigInt(nowBlock.timestamp);

  const taskIds = Object.keys(state.tasks);
  for (const taskId of taskIds) {
    const task = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTask", args: [taskId] });
    const receipts = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTaskReceipts", args: [taskId] });
    const requestHashes = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTaskValidationRequests", args: [taskId] });
    const requiredTags = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "getTaskRequiredValidationTags", args: [taskId] });
    const satisfied = await publicClient.readContract({ address: taskEscrow, abi: taskEscrowAbi, functionName: "validationsSatisfied", args: [taskId] });

    state.tasks[taskId].onchain = {
      community: task.community,
      taskor: task.taskor,
      supplier: task.supplier,
      token: task.token,
      reward: task.reward.toString(),
      supplierFee: task.supplierFee.toString(),
      deadline: task.deadline.toString(),
      createdAt: task.createdAt.toString(),
      challengeDeadline: task.challengeDeadline.toString(),
      status: Number(task.status),
      metadataUri: task.metadataUri,
      evidenceUri: task.evidenceUri,
      taskType: task.taskType,
      juryTaskHash: task.juryTaskHash,
      receipts,
      validationRequests: requestHashes,
      requiredTags,
      validationsSatisfied: satisfied
    };

    const requirements = {};
    for (const tag of requiredTags) {
      const req = await publicClient.readContract({
        address: taskEscrow,
        abi: taskEscrowAbi,
        functionName: "getTaskValidationRequirement",
        args: [taskId, tag]
      });
      requirements[tag] = {
        minCount: req[0].toString(),
        minAvgResponse: req[1],
        minUniqueValidators: req[2],
        enabled: req[3]
      };
    }
    state.tasks[taskId].requirements = requirements;

    const perTaskValidations = [];
    for (const requestHash of requestHashes) {
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
      perTaskValidations.push({
        requestHash,
        validatorAddress: status[0],
        agentId: status[1].toString(),
        response: status[2],
        tag: status[3],
        lastUpdate: status[4].toString(),
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

    const hasRequirements = requiredTags.length > 0 && Object.values(requirements).some((r) => r.enabled);
    const challengeDeadline = BigInt(task.challengeDeadline);
    if (hasRequirements && !satisfied && challengeDeadline > 0n && challengeDeadline < now) {
      state.alerts.push({
        kind: "validation-blocked",
        taskId,
        challengeDeadline: challengeDeadline.toString(),
        requiredTags,
        hint: "Task has unmet validation requirements after challenge deadline"
      });
    }
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

  const bytes = toHex(JSON.stringify(state, null, 2));
  const digest = keccak256(bytes);
  const finalState = { digest, ...state };
  fs.writeFileSync(outFile, JSON.stringify(finalState, null, 2));

  const summary = {
    outFile,
    digest,
    tasks: Object.keys(state.tasks).length,
    validations: Object.keys(state.validations).length,
    agents: Object.keys(state.agents).length,
    alerts: state.alerts.length
  };
  process.stdout.write(JSON.stringify(summary) + "\n");

  if (!serve) return;

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
        metadataUri: onchain.metadataUri ?? null,
        evidenceUri: onchain.evidenceUri ?? null
      };
    });
    arr.sort((a, b) => Number(BigInt(b.createdAt ?? "0") - BigInt(a.createdAt ?? "0")));
    return arr;
  };

  const server = nodeHttp.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = u.pathname;

    if (req.method === "GET" && p === "/health") {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && p === "/state") {
      return sendJson(res, 200, finalState);
    }

    if (req.method === "GET" && p === "/alerts") {
      return sendJson(res, 200, { ok: true, alerts: finalState.alerts });
    }

    if (req.method === "GET" && p === "/tasks") {
      return sendJson(res, 200, { ok: true, tasks: listTasks() });
    }

    if (req.method === "GET" && p.startsWith("/tasks/")) {
      const taskId = p.split("/").pop();
      const task = finalState.tasks[taskId];
      if (!task) return sendJson(res, 404, { error: "not-found" });
      return sendJson(res, 200, { ok: true, task });
    }

    if (req.method === "GET" && p === "/validations") {
      return sendJson(res, 200, { ok: true, validations: flattenValidations() });
    }

    if (req.method === "GET" && p.startsWith("/agents/")) {
      const agentId = p.split("/").pop();
      const agent = finalState.agents[agentId];
      if (!agent) return sendJson(res, 404, { error: "not-found" });
      return sendJson(res, 200, { ok: true, agent });
    }

    if (req.method === "GET" && p === "/agents") {
      const agents = Object.keys(finalState.agents)
        .map((agentId) => ({ agentId, ...finalState.agents[agentId] }))
        .sort((a, b) => Number(BigInt(b.agentId) - BigInt(a.agentId)));
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
      <li><a href="/agents">/agents</a></li>
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

    return sendJson(res, 404, { error: "not-found" });
  });

  server.listen(port, () => {
    process.stdout.write(JSON.stringify({ ok: true, serve: true, port }) + "\n");
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
