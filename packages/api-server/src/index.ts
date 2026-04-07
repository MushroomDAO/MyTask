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
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "11155111");
const REWARD_TOKEN = (process.env.REWARD_TOKEN_ADDRESS ?? "") as Address;
const PAY_TO = (process.env.X402_PAY_TO ?? process.env.TASK_ESCROW_ADDRESS ?? "") as Address;
const TASK_FEE = process.env.TASK_FEE ?? "0"; // token atomic units
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
 * Deterministic receipt ID — same payload + sig always yields the same ID,
 * enabling idempotent retries without re-verifying the nonce.
 */
function generateReceiptId(payload: unknown, sig: string): Hex {
  return keccak256(toBytes(JSON.stringify({ payload, sig })));
}

/**
 * Extracts the payer address from the `x-payment` (or `Payment-Signature`) header.
 * The middleware already validated the signature; we only need the address here.
 *
 * Official v2 envelope:
 *   { x402Version, scheme, network, payload: { authorization: { from }, signature } }
 */
function extractPayer(paymentHeader: string): Address {
  try {
    const decoded = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf-8"));
    const from = decoded?.payload?.authorization?.from as string | undefined;
    return (from ?? "") as Address;
  } catch {
    return "" as Address;
  }
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

// POST /tasks — payment already verified and settled by middleware
app.post("/tasks", async (c) => {
  const paymentHeader =
    c.req.header("x-payment") ?? c.req.header("Payment-Signature") ?? "";

  // Idempotency: if this (payload + sig) was already processed, return stored receipt
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  const potentialId = generateReceiptId(body, paymentHeader);
  const existing = receipts.get(potentialId);
  if (existing) {
    return c.json({
      ok: true,
      receiptId: existing.receiptId,
      receiptUri: existing.receiptUri,
      message: "Duplicate payment detected. Returning existing receipt.",
    });
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
  const receiptId = generateReceiptId(body, paymentHeader);
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
  console.log(`  Fee:         ${TASK_FEE} atomic units`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
  console.log(`  Origins:     ${ALLOWED_ORIGINS.join(", ")}`);
});
