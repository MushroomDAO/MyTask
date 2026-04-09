import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { bodyLimit } from "hono/body-limit";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { keccak256, toBytes, type Hex, type Address, isAddress } from "viem";

// ============================================================
// Config — fail fast if required vars are missing
// ============================================================

const PORT = parseInt(process.env.API_PORT ?? "3401");
// Default to Base Sepolia (84532) — facilitator.x402.org only supports Base (8453) and Base Sepolia (84532)
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "84532");
const REWARD_TOKEN = (process.env.REWARD_TOKEN_ADDRESS ?? "") as Address;
const PAY_TO = (process.env.X402_PAY_TO ?? process.env.TASK_ESCROW_ADDRESS ?? "") as Address;
const TASK_FEE_STR = process.env.TASK_FEE ?? "0"; // token atomic units
const FACILITATOR_URL = process.env.FACILITATOR_URL ?? "https://facilitator.x402.org";
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

let TASK_FEE: bigint;
try {
  TASK_FEE = BigInt(TASK_FEE_STR);
} catch {
  console.error(`[FATAL] TASK_FEE="${TASK_FEE_STR}" is not a valid integer. Exiting.`);
  process.exit(1);
}

// ============================================================
// Receipt store — bounded FIFO map (max 1000 entries)
// ============================================================

const RECEIPT_MAX_SIZE = 1000;

interface Receipt {
  receiptId: Hex;
  receiptUri: string;
  taskPayload: unknown;
  createdAt: string;
  payer: Address;
}

const receipts = new Map<string, Receipt>();

function storeReceipt(id: string, receipt: Receipt): void {
  if (receipts.size >= RECEIPT_MAX_SIZE) {
    const oldest = receipts.keys().next().value;
    if (oldest !== undefined) receipts.delete(oldest);
  }
  receipts.set(id, receipt);
}

/**
 * Deterministic receipt ID derived from the payment signature only.
 * The EIP-3009 authorization is a unique one-time nonce commitment, so the
 * signature alone is a sufficient idempotency key — same payment = same ID.
 */
function generateReceiptId(sig: string): Hex {
  return keccak256(toBytes(sig));
}

/**
 * Extracts the payer address from the `x-payment` (or `Payment-Signature`) header.
 * The middleware already validated the signature; we only need the address here.
 *
 * Official v2 envelope:
 *   { x402Version, scheme, network, payload: { authorization: { from }, signature } }
 */
function extractPayer(paymentHeader: string): Address {
  const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
  const from = decoded?.payload?.authorization?.from as string | undefined;
  if (!from || !isAddress(from)) {
    // middleware already verified the signature — this should never happen
    throw new Error("Cannot extract valid payer address from verified payment header");
  }
  return from;
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
    allowHeaders: ["x-payment", "Payment-Signature", "Content-Type"],
    exposeHeaders: ["x-payment-response"],
  }),
);
app.use("*", logger());
app.use("/tasks", bodyLimit({ maxSize: 50 * 1024 }));

// ============================================================
// x402 middleware — handles 402 discovery, verify, and settle
// ============================================================

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient).register(
  `eip155:${CHAIN_ID}` as `eip155:${number}`,
  new ExactEvmScheme(),
);

// Idempotency pre-check for POST /tasks — MUST be registered before paymentMiddleware.
//
// Problem: paymentMiddleware calls the facilitator on every request. If a client retries
// after a network timeout, the facilitator has already consumed the nonce and returns an
// error, so the handler is never reached and the stored receipt cannot be returned.
//
// Solution: intercept retried requests here (before paymentMiddleware) using the payment
// signature as the idempotency key. The EIP-3009 authorization is a unique one-time
// commitment, so the signature alone identifies the payment unambiguously.
//
// Note: a concurrent retry with the same sig will pass this check (receipt not yet stored)
// and hit paymentMiddleware, but the facilitator will reject it — the on-chain nonce can
// only be consumed once. No double-spend is possible; the race only occurs in the retry
// scenario, which is inherently rare.
app.use("/tasks", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const paymentHeader =
    c.req.header("x-payment") ?? c.req.header("Payment-Signature") ?? "";
  if (paymentHeader) {
    const potentialId = generateReceiptId(paymentHeader);
    const existing = receipts.get(potentialId);
    if (existing) {
      return c.json({
        ok: true,
        receiptId: existing.receiptId,
        receiptUri: existing.receiptUri,
        message: "Duplicate payment detected. Returning existing receipt.",
      });
    }
  }
  return next();
});

app.use(
  paymentMiddleware(
    {
      "POST /tasks": {
        accepts: {
          scheme: "exact",
          // AssetAmount format: specify token contract + atomic units directly
          // This bypasses USD conversion and works with any ERC-20
          price: { amount: TASK_FEE, asset: REWARD_TOKEN },
          network: `eip155:${CHAIN_ID}` as `eip155:${number}`,
          payTo: PAY_TO,
        },
        description: "Pay to create a task on MyTask",
      },
    },
    resourceServer,
  ),
);

// ============================================================
// Routes
// ============================================================

// GET /.well-known/x402 — registered before paymentMiddleware to take priority over any
// SDK-registered discovery route. Provides additional fields (supportedAssets, description)
// beyond the standard SDK response.
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

// POST /tasks — payment already verified and settled by middleware.
// Idempotency is handled upstream in the pre-check middleware (registered before
// paymentMiddleware) so retried requests with the same payment signature never reach
// the facilitator a second time.
app.post("/tasks", async (c) => {
  const paymentHeader =
    c.req.header("x-payment") ?? c.req.header("Payment-Signature") ?? "";

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  const { title, description, rewardAmount, deadlineDays, taskType } = body as {
    title?: string;
    description?: string;
    rewardAmount?: string;
    deadlineDays?: number;
    taskType?: string;
  };

  if (!title || !rewardAmount) {
    return c.json(
      { error: "missing-required-fields", required: ["title", "rewardAmount"] },
      400,
    );
  }

  const payer = extractPayer(paymentHeader);
  const receiptId = generateReceiptId(paymentHeader);
  const receiptUri = `x402://mytask/receipts/${receiptId}`;

  storeReceipt(receiptId, {
    receiptId,
    receiptUri,
    taskPayload: { title, description, rewardAmount, deadlineDays, taskType },
    createdAt: new Date().toISOString(),
    payer,
  });

  return c.json({
    ok: true,
    receiptId,
    receiptUri,
    message:
      "Payment accepted. Use receiptId to call linkReceipt on-chain after creating task.",
  });
});

// GET /receipts/:receiptId
app.get("/receipts/:receiptId", (c) => {
  const { receiptId } = c.req.param();
  const receipt = receipts.get(receiptId);
  if (!receipt) return c.json({ error: "not-found" }, 404);
  return c.json({ ok: true, receipt });
});

// ============================================================
// Start
// ============================================================

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[mytask-api-server] listening on http://localhost:${PORT}`);
  console.log(`  Chain:       eip155:${CHAIN_ID}`);
  console.log(`  Token:       ${REWARD_TOKEN}`);
  console.log(`  PayTo:       ${PAY_TO}`);
  console.log(`  Fee:         ${TASK_FEE_STR} atomic units`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
  console.log(`  Origins:     ${ALLOWED_ORIGINS.join(", ")}`);
});
