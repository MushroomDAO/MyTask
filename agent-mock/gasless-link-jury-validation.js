#!/usr/bin/env node
const {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  concat,
  pad,
  keccak256,
  toHex
} = require("viem");
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

  if (mode === "orchestrateTasks") {
    const once = parseBool(getArgValue(argv, "--once"), false);
    const autoAccept = parseBool(getArgValue(argv, "--autoAccept"), true);
    const autoSubmit = parseBool(getArgValue(argv, "--autoSubmit"), true);
    const evidenceUri =
      getArgValue(argv, "--evidenceUri") ??
      process.env.EVIDENCE_URI ??
      "ipfs://evidence";
    const receiptUri = getArgValue(argv, "--receiptUri") ?? process.env.RECEIPT_URI;

    const privateKeyRaw = getArgValue(argv, "--privateKey") ?? requireEnv("PRIVATE_KEY");
    const privateKey = privateKeyRaw.startsWith("0x") ? privateKeyRaw : `0x${privateKeyRaw}`;
    const account = privateKeyToAccount(privateKey);

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
      }
    ];

    const sendTx = async ({ to, data }) => {
      if (dryRun) {
        process.stdout.write(JSON.stringify({ to, data, from: account.address, dryRun: true }) + "\n");
        return null;
      }
      const hash = await walletClient.sendTransaction({ to, data, value: 0n });
      await publicClient.waitForTransactionReceipt({ hash });
      return hash;
    };

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

          const task = await publicClient.readContract({
            address: taskEscrow,
            abi: taskEscrowAbi,
            functionName: "getTask",
            args: [taskId]
          });

          const status = Number(task.status);
          const shouldAccept = autoAccept && status === 0;
          const shouldSubmit =
            autoSubmit &&
            (status === 1 || status === 2) &&
            String(task.taskor).toLowerCase() === account.address.toLowerCase();

          if (shouldAccept) {
            const data = encodeFunctionData({
              abi: taskEscrowAbi,
              functionName: "acceptTask",
              args: [taskId]
            });
            const txHash = await sendTx({ to: taskEscrow, data });
            process.stdout.write(JSON.stringify({ mode, action: "acceptTask", taskId, txHash }) + "\n");
          }

          if (shouldSubmit) {
            const data = encodeFunctionData({
              abi: taskEscrowAbi,
              functionName: "submitWork",
              args: [taskId, evidenceUri]
            });
            const txHash = await sendTx({ to: taskEscrow, data });
            process.stdout.write(
              JSON.stringify({ mode, action: "submitWork", taskId, evidenceUri, txHash }) + "\n"
            );

            if (receiptUri) {
              const receiptId = keccak256(toHex(receiptUri));
              const linkReceiptData = encodeFunctionData({
                abi: taskEscrowAbi,
                functionName: "linkReceipt",
                args: [taskId, receiptId, receiptUri]
              });
              const linkReceiptTxHash = await sendTx({ to: taskEscrow, data: linkReceiptData });
              process.stdout.write(
                JSON.stringify({ mode, action: "linkReceipt", taskId, receiptId, receiptUri, txHash: linkReceiptTxHash }) + "\n"
              );
            }
          }

          if (once) {
            unwatch();
            process.exit(0);
          }
        }
      }
    });

    return;
  }

  if (mode !== "linkJuryValidation" && mode !== "linkReceipt" && mode !== "linkValidationReceipt") {
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
    mode === "linkValidationReceipt"
      ? getArgValue(argv, "--requestHash") ?? requireEnv("VALIDATION_REQUEST_HASH")
      : undefined;
  const juryContractAddress =
    mode === "linkValidationReceipt"
      ? getArgValue(argv, "--juryContract") ?? requireEnv("JURY_CONTRACT_ADDRESS")
      : undefined;
  const receiptUri =
    mode === "linkReceipt" || mode === "linkValidationReceipt"
      ? getArgValue(argv, "--receiptUri") ?? requireEnv("RECEIPT_URI")
      : undefined;
  const receiptIdRaw =
    mode === "linkReceipt" || mode === "linkValidationReceipt"
      ? getArgValue(argv, "--receiptId") ?? process.env.RECEIPT_ID
      : undefined;
  const receiptId =
    mode === "linkReceipt" || mode === "linkValidationReceipt"
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

  const target = mode === "linkValidationReceipt" ? juryContractAddress : taskEscrow;
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
