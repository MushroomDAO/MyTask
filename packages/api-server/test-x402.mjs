/**
 * x402 API Server Integration Test
 * Run: node test-x402.mjs
 *
 * Uses the official x402 v2 payment payload envelope:
 *   { x402Version: 2, scheme, network, payload: { authorization, signature } }
 *
 * Tests:
 *  1.  GET /health
 *  2.  GET /.well-known/x402
 *  3a. POST /tasks — no body (empty probe) → 402
 *  3b. POST /tasks — body but no payment header → 402
 *  4.  POST /tasks — valid EIP-3009 payment → 200 + receiptId
 *  5.  GET /receipts/:receiptId → receipt details
 *  6.  Idempotent retry → same receiptId
 *  7.  Nonce replay → rejected
 */

import { privateKeyToAccount } from "viem/accounts";

const BASE_URL = "http://localhost:3401";

// ── helpers ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  ✓  ${label}`);
  passed++;
}

function fail(label, reason) {
  console.error(`  ✗  ${label}: ${reason}`);
  failed++;
}

async function assertStatus(label, res, expected) {
  if (res.status === expected) {
    ok(`${label} → ${expected}`);
  } else {
    const body = await res.text().catch(() => "");
    fail(`${label} → ${expected}`, `got ${res.status} ${body.slice(0, 200)}`);
  }
}

function randomBytes32() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── read server config from .env ──────────────────────────────────────────

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, ".env");

let envVars = {};
try {
  const raw = readFileSync(envPath, "utf-8");
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) envVars[m[1]] = m[2].trim();
  }
} catch {
  console.error("ERROR: .env file not found. Copy .env.example → .env and fill in values.");
  process.exit(1);
}

const CHAIN_ID = parseInt(envVars.CHAIN_ID ?? "11155111");
const TOKEN_ADDRESS = envVars.REWARD_TOKEN_ADDRESS;
const TOKEN_NAME = envVars.REWARD_TOKEN_NAME ?? "USDC";
const TOKEN_VERSION = envVars.REWARD_TOKEN_VERSION ?? "2";
const PAY_TO = envVars.X402_PAY_TO ?? envVars.TASK_ESCROW_ADDRESS;
const TASK_FEE = BigInt(envVars.TASK_FEE ?? "0");
const NETWORK = `eip155:${CHAIN_ID}`;

// ── test signer ───────────────────────────────────────────────────────────
const PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const account = privateKeyToAccount(PRIVATE_KEY);

// EIP-712 types for EIP-3009
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

/**
 * Builds an x402 v2 payment header (base64-encoded JSON) following the official
 * ExactEvmPayloadV2 envelope:
 *   { x402Version: 2, scheme, network, payload: { authorization, signature } }
 */
async function buildPaymentHeader(nonce) {
  const from = account.address;
  const to = PAY_TO;
  const value = TASK_FEE;
  const validAfter = 0n;
  const validBefore = BigInt(Math.floor(Date.now() / 1000)) + 3600n;
  const n = nonce ?? randomBytes32();

  const signature = await account.signTypedData({
    domain: {
      name: TOKEN_NAME,
      version: TOKEN_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: TOKEN_ADDRESS,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from, to, value, validAfter, validBefore, nonce: n },
  });

  // Official x402 v2 payload envelope
  const envelope = {
    x402Version: 2,
    scheme: "exact",
    network: NETWORK,
    payload: {
      authorization: {
        from,
        to,
        value: value.toString(),
        validAfter: validAfter.toString(),
        validBefore: validBefore.toString(),
        nonce: n,
      },
      signature,
    },
  };

  return { header: btoa(JSON.stringify(envelope)), nonce: n };
}

const TASK_PAYLOAD = {
  title: "Test Task from integration test",
  description: "Automated test",
  rewardAmount: "1.0",
  deadlineDays: 7,
  taskType: "0x0000000000000000000000000000000000000000000000000000000000000001",
};

// ── run tests ─────────────────────────────────────────────────────────────

console.log(`\n[x402 integration tests]  ${BASE_URL}\n`);

// 1. Health
const healthRes = await fetch(`${BASE_URL}/health`);
await assertStatus("GET /health", healthRes, 200);

// 2. Well-known
const wkRes = await fetch(`${BASE_URL}/.well-known/x402`);
await assertStatus("GET /.well-known/x402", wkRes, 200);
if (wkRes.ok) {
  const wk = await wkRes.clone().json();
  if (wk.supportedSchemes?.includes("exact")) ok(".well-known has scheme=exact");
  else fail(".well-known scheme", `got ${JSON.stringify(wk.supportedSchemes)}`);
}

// 3a. POST /tasks with no body at all → 402 (x402 discovery probe)
const probeRes = await fetch(`${BASE_URL}/tasks`, { method: "POST" });
await assertStatus("POST /tasks (empty probe, no body)", probeRes, 402);

// 3b. POST /tasks with body but no payment header → 402
const noPayRes = await fetch(`${BASE_URL}/tasks`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(TASK_PAYLOAD),
});
await assertStatus("POST /tasks (no payment header)", noPayRes, 402);

// 4. POST /tasks with valid EIP-3009 payment → 200
const { header: paymentSig, nonce } = await buildPaymentHeader();
const payRes = await fetch(`${BASE_URL}/tasks`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-payment": paymentSig,
  },
  body: JSON.stringify(TASK_PAYLOAD),
});
await assertStatus("POST /tasks (with payment)", payRes, 200);
let receiptId;
if (payRes.ok) {
  const data = await payRes.json();
  if (data.receiptId?.startsWith("0x")) {
    ok(`receiptId returned: ${data.receiptId.slice(0, 18)}…`);
    receiptId = data.receiptId;
  } else {
    fail("receiptId format", JSON.stringify(data));
  }
}

// 5. GET /receipts/:receiptId
if (receiptId) {
  const rRes = await fetch(`${BASE_URL}/receipts/${receiptId}`);
  await assertStatus("GET /receipts/:id", rRes, 200);
  if (rRes.ok) {
    const d = await rRes.json();
    if (d.receipt?.payer?.toLowerCase() === account.address.toLowerCase()) {
      ok(`payer matches: ${d.receipt.payer.slice(0, 10)}…`);
    } else {
      fail("payer mismatch", JSON.stringify(d.receipt?.payer));
    }
    if (d.receipt?.createdAt) ok("createdAt present");
  }
}

// 6. Idempotent retry (same payload + sig → same receiptId)
if (receiptId) {
  const retryRes = await fetch(`${BASE_URL}/tasks`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-payment": paymentSig,
    },
    body: JSON.stringify(TASK_PAYLOAD),
  });
  await assertStatus("POST /tasks (idempotent retry)", retryRes, 200);
  if (retryRes.ok) {
    const d = await retryRes.json();
    if (d.receiptId === receiptId) ok("same receiptId on retry (idempotent)");
    else fail("idempotent retry", `got different receiptId: ${d.receiptId}`);
  }
}

// 7. Replay: same nonce with different body → facilitator/middleware should reject
const replayRes = await fetch(`${BASE_URL}/tasks`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-payment": paymentSig, // same sig, different body → different receiptId but same nonce
  },
  body: JSON.stringify({ ...TASK_PAYLOAD, title: "Replay attempt" }),
});
// Facilitator checks authorizationState on-chain; used nonce → 402 or 400
if (replayRes.status === 402 || replayRes.status === 400) {
  ok(`Nonce replay rejected (${replayRes.status})`);
} else if (replayRes.status === 200) {
  fail("Nonce replay", "server accepted a replayed nonce!");
} else {
  ok(`Nonce replay returned ${replayRes.status} (acceptable)`);
}

// ── summary ───────────────────────────────────────────────────────────────

console.log(`\n  ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
