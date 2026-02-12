#!/usr/bin/env node
const { createPublicClient, http, encodeFunctionData, concat, pad } = require("viem");
const { privateKeyToAccount } = require("viem/accounts");
const path = require("path");
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

  const entryPoint = getArgValue(argv, "--entryPoint") ??
    process.env.ENTRYPOINT_ADDRESS ??
    "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

  const taskEscrow = getArgValue(argv, "--taskEscrow") ?? requireEnv("TASK_ESCROW_ADDRESS");

  const publicClient = createPublicClient({
    chain: { id: chainId, name: "custom", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } },
    transport: http(rpcUrl)
  });

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
          process.stdout.write(JSON.stringify({ mode, address: taskEscrow, log: { ...log, args } }) + "\n");
          if (once) {
            unwatch();
            process.exit(0);
          }
        }
      }
    });

    return;
  }

  const bundlerUrl = getArgValue(argv, "--bundlerUrl") ?? requireEnv("BUNDLER_URL");
  const privateKeyRaw = getArgValue(argv, "--privateKey") ?? requireEnv("PRIVATE_KEY");
  const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
  const superPaymaster = getArgValue(argv, "--paymaster") ?? requireEnv("SUPER_PAYMASTER_ADDRESS");
  const operator = getArgValue(argv, "--operator") ?? requireEnv("OPERATOR_ADDRESS");
  const aaAccount = getArgValue(argv, "--aaAccount") ?? requireEnv("AA_ACCOUNT_ADDRESS");

  const taskId = getArgValue(argv, "--taskId") ?? requireEnv("TASK_ID");
  const juryTaskHash = getArgValue(argv, "--juryTaskHash") ?? requireEnv("JURY_TASK_HASH");

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
    { type: "function", name: "linkJuryValidation", stateMutability: "nonpayable", inputs: [{ type: "bytes32" }, { type: "bytes32" }], outputs: [] }
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

  const linkData = encodeFunctionData({
    abi: taskEscrowAbi,
    functionName: "linkJuryValidation",
    args: [taskId, juryTaskHash]
  });

  const callData = encodeFunctionData({
    abi: aaAbi,
    functionName: "execute",
    args: [taskEscrow, 0n, linkData]
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
