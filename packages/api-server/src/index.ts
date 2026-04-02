import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { keccak256, toBytes, type Hex } from "viem";

// ============================================================
// Config
// ============================================================

const PORT = parseInt(process.env.API_PORT ?? "3401");
const CHAIN_ID = parseInt(process.env.CHAIN_ID ?? "11155111"); // Sepolia default
const REWARD_TOKEN = (process.env.REWARD_TOKEN_ADDRESS ?? "") as `0x${string}`;
const ESCROW_ADDRESS = (process.env.TASK_ESCROW_ADDRESS ?? "") as `0x${string}`;
// Address that receives the x402 payment (facilitator / treasury)
const PAY_TO = (process.env.X402_PAY_TO ?? ESCROW_ADDRESS) as `0x${string}`;
// Default task creation fee in token's atomic units (e.g. 1 USDC = 1_000_000)
const TASK_FEE = BigInt(process.env.TASK_FEE ?? "0");

// ============================================================
// x402 Header names (per spec)
// ============================================================
const HEADER_PAYMENT_REQUIRED = "Payment-Required";
const HEADER_PAYMENT_SIGNATURE = "Payment-Signature";

// ============================================================
// In-memory receipt store (swap for DB in production)
// ============================================================
interface Receipt {
  receiptId: Hex;
  receiptUri: string;
  taskPayload: unknown;
  createdAt: string;
  paymentHeader: string;
}

const receipts = new Map<string, Receipt>();

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
        extra: { name: "USDC", version: "2" },
      },
    ],
    error: "Payment required to create task",
    resource: requestPath,
  };
}

function verifyPaymentSignaturePresent(header: string | undefined): boolean {
  // MVP: check header exists and is non-empty base64
  // Full implementation would decode and verify EIP-3009 signature on-chain
  return !!header && header.length > 20;
}

function generateReceiptId(payload: unknown, sig: string): Hex {
  return keccak256(toBytes(JSON.stringify({ payload, sig, ts: Date.now() })));
}

// ============================================================
// App
// ============================================================

const app = new Hono();

app.use("*", cors());
app.use("*", logger());

// GET /.well-known/x402 — announce supported payment schemes
app.get("/.well-known/x402", (c) => {
  return c.json({
    version: 2,
    supportedSchemes: ["exact"],
    supportedNetworks: [`eip155:${CHAIN_ID}`],
    supportedAssets: REWARD_TOKEN ? [REWARD_TOKEN] : [],
    payTo: PAY_TO,
    description: "MyTask API — pay to create tasks",
  });
});

// GET /health
app.get("/health", (c) => c.json({ ok: true, service: "mytask-api-server" }));

// POST /tasks — requires x402 payment
// If no PAYMENT-SIGNATURE header → return 402
// If header present → validate & create receipt, return receiptId
app.post("/tasks", async (c) => {
  const paymentSig = c.req.header(HEADER_PAYMENT_SIGNATURE);

  if (!verifyPaymentSignaturePresent(paymentSig)) {
    // Return 402 with payment requirements
    const pr = buildPaymentRequired(TASK_FEE, "/tasks");
    c.res.headers.set(HEADER_PAYMENT_REQUIRED, JSON.stringify(pr));
    return c.json(
      { error: "payment-required", details: pr },
      402
    );
  }

  // Payment signature present — parse request body
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid-json" }, 400);
  }

  // Validate required fields
  const { title, description, rewardAmount, deadlineDays, taskType } = body as {
    title?: string;
    description?: string;
    rewardAmount?: string;
    deadlineDays?: number;
    taskType?: string;
  };

  if (!title || !rewardAmount) {
    return c.json({ error: "missing-required-fields", required: ["title", "rewardAmount"] }, 400);
  }

  // Generate receipt
  const receiptId = generateReceiptId(body, paymentSig!);
  const receiptUri = `x402://mytask/receipts/${receiptId}`;
  const receipt: Receipt = {
    receiptId,
    receiptUri,
    taskPayload: { title, description, rewardAmount, deadlineDays, taskType },
    createdAt: new Date().toISOString(),
    paymentHeader: paymentSig!,
  };
  receipts.set(receiptId, receipt);

  return c.json({
    ok: true,
    receiptId,
    receiptUri,
    message: "Payment accepted. Use receiptId to call linkReceipt on-chain after creating task.",
  });
});

// GET /receipts/:receiptId — retrieve receipt details
app.get("/receipts/:receiptId", (c) => {
  const { receiptId } = c.req.param();
  const receipt = receipts.get(receiptId);
  if (!receipt) {
    return c.json({ error: "not-found" }, 404);
  }
  return c.json({ ok: true, receipt });
});

// GET /receipts — list recent receipts
app.get("/receipts", (c) => {
  const list = [...receipts.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 50)
    .map(({ receiptId, receiptUri, createdAt }) => ({ receiptId, receiptUri, createdAt }));
  return c.json({ ok: true, receipts: list });
});

// ============================================================
// Start
// ============================================================

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[mytask-api-server] listening on http://localhost:${PORT}`);
  console.log(`  Chain: eip155:${CHAIN_ID}`);
  console.log(`  Reward token: ${REWARD_TOKEN || "(not configured)"}`);
  console.log(`  Escrow: ${ESCROW_ADDRESS || "(not configured)"}`);
});
