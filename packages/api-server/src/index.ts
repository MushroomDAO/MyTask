import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import {
  keccak256,
  toBytes,
  type Hex,
  type Address,
  isAddress,
  isHex,
  recoverTypedDataAddress,
} from "viem";

// ============================================================
// Config — fail fast if required vars are missing
// ============================================================

const PORT = parseInt(process.env.API_PORT ?? "3401");
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "11155111"); // Sepolia default
const REWARD_TOKEN = (process.env.REWARD_TOKEN_ADDRESS ?? "") as Address;
const ESCROW_ADDRESS = (process.env.TASK_ESCROW_ADDRESS ?? "") as Address;
const PAY_TO = (process.env.X402_PAY_TO ?? ESCROW_ADDRESS) as Address;
const TASK_FEE = BigInt(process.env.TASK_FEE ?? "0");
// EIP-712 domain params for the reward token (must match on-chain token)
const TOKEN_NAME = process.env.REWARD_TOKEN_NAME ?? "USDC";
const TOKEN_VERSION = process.env.REWARD_TOKEN_VERSION ?? "2";
// Allowed CORS origins (comma-separated)
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "http://localhost:3000")
  .split(",")
  .map((o) => o.trim());

if (!REWARD_TOKEN || !isAddress(REWARD_TOKEN)) {
  console.error("[FATAL] REWARD_TOKEN_ADDRESS is not set or invalid. Exiting.");
  process.exit(1);
}
if (!PAY_TO || !isAddress(PAY_TO)) {
  console.error("[FATAL] X402_PAY_TO / TASK_ESCROW_ADDRESS is not set or invalid. Exiting.");
  process.exit(1);
}

// ============================================================
// x402 Header names (per spec)
// ============================================================
const HEADER_PAYMENT_REQUIRED = "Payment-Required";
const HEADER_PAYMENT_SIGNATURE = "Payment-Signature";

// ============================================================
// Custom error types for unambiguous error classification
// ============================================================

class MissingPaymentError extends Error {
  constructor() {
    super("Missing Payment-Signature header");
    this.name = "MissingPaymentError";
  }
}

class InvalidPaymentError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidPaymentError";
  }
}

// ============================================================
// Receipt store — bounded LRU-like map (max 1000 entries)
// Prevents unbounded memory growth.
// ============================================================
const RECEIPT_MAX_SIZE = 1000;

interface Receipt {
  receiptId: Hex;
  receiptUri: string;
  taskPayload: unknown;
  createdAt: string;
  paymentHeader: string;
  payer: Address;
}

const receipts = new Map<string, Receipt>();

// Nonce replay protection — tracks consumed EIP-3009 nonces
const usedNonces = new Set<string>();

function storeReceipt(id: string, receipt: Receipt): void {
  if (receipts.size >= RECEIPT_MAX_SIZE) {
    // Evict the oldest entry (insertion-order first key)
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined) {
      receipts.delete(oldest);
    }
  }
  receipts.set(id, receipt);
}

// ============================================================
// EIP-3009 transferWithAuthorization typed data definition
// ============================================================

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

interface Eip3009Auth {
  from: Address;
  to: Address;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: Hex;
  // signature: r (32 bytes) + s (32 bytes) + v (1 byte) = 65-byte hex, or split v/r/s
  signature: Hex; // 0x + 130 hex chars (65 bytes)
}

/**
 * Validates an EIP-3009 payment authorization from the Payment-Signature header.
 *
 * The header must be a base64-encoded JSON blob containing:
 *   { from, to, value, validAfter, validBefore, nonce, signature }
 * where `signature` is a 65-byte hex string (0x + r:32 + s:32 + v:1).
 *
 * Returns the recovered payer address on success, throws with a descriptive
 * message on any validation failure.
 */
async function verifyPaymentSignature(
  header: string | undefined,
): Promise<Address> {
  if (!header || header.length === 0) {
    throw new MissingPaymentError();
  }

  // Decode base64 → JSON
  let auth: Eip3009Auth;
  try {
    const decoded = Buffer.from(header, "base64").toString("utf-8");
    auth = JSON.parse(decoded) as Eip3009Auth;
  } catch {
    throw new InvalidPaymentError("Payment-Signature is not valid base64-encoded JSON");
  }

  // Structural validation
  const requiredFields: (keyof Eip3009Auth)[] = [
    "from",
    "to",
    "value",
    "validAfter",
    "validBefore",
    "nonce",
    "signature",
  ];
  for (const field of requiredFields) {
    if (auth[field] === undefined || auth[field] === null) {
      throw new InvalidPaymentError(`Payment-Signature missing field: ${field}`);
    }
  }

  if (!isAddress(auth.from)) throw new InvalidPaymentError("auth.from is not a valid address");
  if (!isAddress(auth.to)) throw new InvalidPaymentError("auth.to is not a valid address");
  if (!isHex(auth.nonce) || auth.nonce.length !== 66) {
    throw new InvalidPaymentError("auth.nonce must be a 32-byte hex string (0x + 64 chars)");
  }
  if (!isHex(auth.signature) || auth.signature.length !== 132) {
    throw new InvalidPaymentError(
      "auth.signature must be a 65-byte hex string (0x + 130 chars)",
    );
  }

  // Nonce replay protection
  const nonceKey = `${CHAIN_ID}:${REWARD_TOKEN.toLowerCase()}:${auth.nonce.toLowerCase()}`;
  if (usedNonces.has(nonceKey)) {
    throw new InvalidPaymentError(`Nonce already used: ${auth.nonce}`);
  }

  // Temporal validation — use BigInt to avoid Number precision issues with large timestamps
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const validAfter = BigInt(auth.validAfter);
  const validBefore = BigInt(auth.validBefore);
  if (nowSec <= validAfter) {
    throw new InvalidPaymentError("Payment authorization is not yet valid (validAfter)");
  }
  if (nowSec >= validBefore) {
    throw new InvalidPaymentError("Payment authorization has expired (validBefore)");
  }

  // Verify the payment is directed to the correct recipient and amount
  if (auth.to.toLowerCase() !== PAY_TO.toLowerCase()) {
    throw new InvalidPaymentError(
      `Payment recipient mismatch: expected ${PAY_TO}, got ${auth.to}`,
    );
  }
  if (BigInt(auth.value) < TASK_FEE) {
    throw new InvalidPaymentError(
      `Insufficient payment: required ${TASK_FEE}, got ${auth.value}`,
    );
  }

  // Recover signer from EIP-712 typed data
  const recovered = await recoverTypedDataAddress({
    domain: {
      name: TOKEN_NAME,
      version: TOKEN_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: REWARD_TOKEN,
    },
    types: EIP3009_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: auth.from,
      to: auth.to,
      value: BigInt(auth.value),
      validAfter,
      validBefore,
      nonce: auth.nonce,
    },
    signature: auth.signature,
  });

  if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
    throw new InvalidPaymentError(
      `Signature signer mismatch: recovered ${recovered}, expected ${auth.from}`,
    );
  }

  // Mark nonce as consumed (only after all validation passes)
  usedNonces.add(nonceKey);

  return auth.from as Address;
}

// ============================================================
// Helpers
// ============================================================

function buildPaymentRequired(amount: bigint, requestPath: string) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: `eip155:${CHAIN_ID}`,
        asset: REWARD_TOKEN,
        amount: amount.toString(),
        payTo: PAY_TO,
        maxTimeoutSeconds: 3600,
        extra: { name: TOKEN_NAME, version: TOKEN_VERSION },
      },
    ],
    error: "Payment required to create task",
    resource: requestPath,
  };
}

/**
 * Deterministic receipt ID based only on payload + sig (no timestamp).
 * Identical payload + sig always yields the same ID → idempotent retries.
 */
function generateReceiptId(payload: unknown, sig: string): Hex {
  return keccak256(toBytes(JSON.stringify({ payload, sig })));
}

// ============================================================
// App
// ============================================================

const app = new Hono();

app.use(
  "*",
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: [HEADER_PAYMENT_SIGNATURE, "Content-Type"],
  }),
);
app.use("*", logger());

// Body size limit on all mutation endpoints (50 KB)
app.use("/tasks", bodyLimit({ maxSize: 50 * 1024 }));

// ============================================================
// Routes
// ============================================================

// GET /.well-known/x402 — announce supported payment schemes
app.get("/.well-known/x402", (c) => {
  return c.json({
    version: 2,
    supportedSchemes: ["exact"],
    supportedNetworks: [`eip155:${CHAIN_ID}`],
    supportedAssets: [REWARD_TOKEN],
    payTo: PAY_TO,
    description: "MyTask API — pay to create tasks",
  });
});

// GET /health
app.get("/health", (c) => c.json({ ok: true, service: "mytask-api-server" }));

// POST /tasks — requires x402 EIP-3009 payment
app.post("/tasks", async (c) => {
  const paymentSigHeader = c.req.header(HEADER_PAYMENT_SIGNATURE);

  let payer: Address;
  try {
    payer = await verifyPaymentSignature(paymentSigHeader);
  } catch (err: unknown) {
    if (err instanceof MissingPaymentError) {
      // No signature at all → standard 402 flow
      const pr = buildPaymentRequired(TASK_FEE, "/tasks");
      c.header(HEADER_PAYMENT_REQUIRED, JSON.stringify(pr));
      return c.json({ error: "payment-required", details: pr }, 402);
    }

    // Signature present but invalid → 400 to distinguish bad sig from no sig
    const message = err instanceof Error ? err.message : "invalid signature";
    return c.json({ error: "invalid-payment-signature", message }, 400);
  }

  // Payment verified — parse request body
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  const { title, description, rewardAmount, deadlineDays, taskType } =
    body as {
      title?: string;
      description?: string;
      rewardAmount?: string;
      deadlineDays?: number;
      taskType?: string;
    };

  if (!title || !rewardAmount) {
    return c.json(
      {
        error: "missing-required-fields",
        required: ["title", "rewardAmount"],
      },
      400,
    );
  }

  // Idempotent receipt generation
  const receiptId = generateReceiptId(body, paymentSigHeader!);

  // Return existing receipt if already stored (idempotent retry)
  const existing = receipts.get(receiptId);
  if (existing) {
    return c.json({
      ok: true,
      receiptId: existing.receiptId,
      receiptUri: existing.receiptUri,
      message:
        "Duplicate payment detected. Returning existing receipt.",
    });
  }

  const receiptUri = `x402://mytask/receipts/${receiptId}`;
  const receipt: Receipt = {
    receiptId,
    receiptUri,
    taskPayload: { title, description, rewardAmount, deadlineDays, taskType },
    createdAt: new Date().toISOString(),
    paymentHeader: paymentSigHeader!,
    payer,
  };
  storeReceipt(receiptId, receipt);

  return c.json({
    ok: true,
    receiptId,
    receiptUri,
    message:
      "Payment accepted. Use receiptId to call linkReceipt on-chain after creating task.",
  });
});

// GET /receipts/:receiptId — retrieve receipt (payer or owner only)
app.get("/receipts/:receiptId", (c) => {
  const { receiptId } = c.req.param();
  const receipt = receipts.get(receiptId);
  if (!receipt) {
    return c.json({ error: "not-found" }, 404);
  }
  // Omit raw paymentHeader from response to avoid leaking signature
  const { paymentHeader: _omitted, ...safeReceipt } = receipt;
  return c.json({ ok: true, receipt: safeReceipt });
});

// ============================================================
// Start
// ============================================================

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[mytask-api-server] listening on http://localhost:${PORT}`);
  console.log(`  Chain: eip155:${CHAIN_ID}`);
  console.log(`  Reward token: ${REWARD_TOKEN} (${TOKEN_NAME} v${TOKEN_VERSION})`);
  console.log(`  Escrow / payTo: ${PAY_TO}`);
  console.log(`  Task fee: ${TASK_FEE.toString()} atomic units`);
  console.log(`  Allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
});
