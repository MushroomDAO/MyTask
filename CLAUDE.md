# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

MyTask is a four-party task escrow (Community publishes and funds, Taskor executes, optional Supplier provides resources, Jury validates) on EVM, paid through x402 and validated through ERC-8004. License is Apache-2.0 (see LICENSE/NOTICE/TRADEMARK; CLA required on PRs). It is one repo in the AAStar / MushroomDAO ecosystem: SuperPaymaster (Registry + canonical MySBT), aastar-sdk (gasless PaymasterClient), MyShop (RewardAction) and the cos72 frontend live in sibling directories (`../`, see `MyTask.code-workspace`) and are referenced by docs and scripts but are not in this repo.

There is no root package.json or workspace. Three units build independently:

| Dir | What | Toolchain |
|---|---|---|
| `contracts/` | Core: TaskEscrow (V1), TaskEscrowV2, JuryContract, MySBT | Foundry; the only part with CI |
| `packages/api-server/` | Hono server; `POST /tasks` paywalled with the official `@x402/hono` SDK | pnpm, tsx, TS strict |
| `agent-mock/` | Plain Node/CommonJS scripts (viem, no framework): orchestrator, indexer, local x402 proxy | npm (has package-lock.json) |
| `submodules/` | Six reference repos (payload-exchange, paybot, zkx402, halo, hubble-ai-trading, Tasks) | Read-only inspiration; never built or imported |
| `docs/` | `TotalSolution.md` is the cross-repo "single source of truth" review doc. ADRs and the *-Analysis docs describe aspirations (LangGraph agents, Cloudflare Workers) that are not implemented here | |

## Commands

### Contracts (`cd contracts`)

```bash
git submodule update --init --recursive   # forge-std is a submodule under contracts/lib (gitignored at root)
forge build
forge test                                # ~2.5 min on a laptop: the invariant suite runs 256 runs x 128k calls
forge test --no-match-path '*invariant*'  # fast loop
forge test --match-contract TaskEscrowV2Test
forge test --match-test test_ChallengeWork -vvv
forge fmt && forge fmt --check            # CI fails on fmt diffs; several files currently do not pass
FOUNDRY_PROFILE=solc-0-8-33 forge build   # pin solc 0.8.33 (default profile uses the installed solc)
```

Deploy scripts (`contracts/script/`), all of which print the addresses they create:

```bash
anvil -p 8545
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
  # TaskEscrowV2 + permissive JuryContract + mock USDC/xPNT; prints NEXT_PUBLIC_* lines for the frontend .env.local
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
  # V1 TaskEscrow + JuryContract (+ fresh MySBT unless MYSBT_ADDRESS is set)
forge script script/Deploy.s.sol:DemoLifecycle --rpc-url http://127.0.0.1:8545 --broadcast
  # full V1 happy path with role gating ON: jurors stake, task, jury vote, ERC-8004 request/response, settle
DEPLOYER_PRIVATE_KEY=0x... forge script script/DeploySepolia.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
  # env-driven, never hardcodes a key, never deploys MySBT (uses the ecosystem canonical SBT)
```

Current Sepolia addresses are in `contracts/broadcast/DeploySepolia.s.sol/11155111/README.md`. `run-latest.json` is the MT-8 redeploy; the older run files record a superseded deployment with a jury-share fund leak and native-ETH challenge stake, so never point clients at those addresses.

### API server (`cd packages/api-server`)

```bash
pnpm install && cp .env.example .env     # server exits at boot if REWARD_TOKEN_ADDRESS or X402_PAY_TO is missing/invalid
pnpm dev                                 # tsx watch src/index.ts on :3401
pnpm start / pnpm build                  # tsx once / tsc to dist/
node test-x402.mjs                       # integration test against a running server; needs .env incl. REWARD_TOKEN_NAME/VERSION for EIP-712
```

### agent-mock (`cd agent-mock`)

```bash
npm install
npm run x402:proxy                                     # :8787, POST /pay -> receipts/, dashboard at /, /stats, /receipts, /metrics
npm run orchestrateTasks -- --once true --agentId 1 --validationMinCount 1 --validationTag QUALITY
npm run index -- --out out/index.json                  # or: node indexer.js --serve true --port 8790
npm run linkJuryValidation -- --mode linkReceipt --taskId 0x... --receiptUri ipfs://... --dryRun true
```

All three scripts load `.env` from `process.cwd()`, so run them from `agent-mock/` with the `.env` there (the README says repo root; the code reads cwd). Minimum env: `RPC_URL`, `TASK_ESCROW_ADDRESS`, `JURY_CONTRACT_ADDRESS`, `PRIVATE_KEY`. Most flags have an env twin (e.g. `--x402ProxyUrl` / `X402_PROXY_URL`). `--dryRun` defaults to `true`.

## On-chain architecture (`contracts/src`)

### Two escrow generations coexist and are not interchangeable

| | `TaskEscrow` (V1) | `TaskEscrowV2` |
|---|---|---|
| Implements `ITaskEscrow` | yes | no: own ABI, positional `createTask(token, reward, deadline, metadataUri, taskType)` |
| Flow | CREATED → ACCEPTED → SUBMITTED → VALIDATED → COMPLETED. `completeTask` requires `linkJuryValidation` to a COMPLETED jury task first | Optimistic: Open → Accepted → Submitted → challenge window (default 3 days) → Finalized by `finalizeTask` (anyone) or `approveWork` (community). Community may `challengeWork`; then `linkJuryValidation` decides Finalized vs Refunded, and the challenge stake goes back to the challenger or to the taskor |
| Entry points | `submitEvidence`, `completeTask`, `raiseDispute` | `submitWork`, `finalizeTask`, `challengeWork`, `linkReceipt` |
| Gasless | EIP-2612 `createTaskWithPermit` | none in-contract; gasless is the AA/paymaster layer's job |
| V2-only | | ERC-20 challenge stake (AA-compatible, token snapshotted per task, fee-on-transfer safe), per-task ERC-8004 validation requirements, task policy caps, owner/pause, custom errors |
| Deployed by | `Deploy.s.sol`, `DemoLifecycle` | `DeployLocal`, `DeploySepolia` (the live Sepolia deployment) |

Active work (the MT-1 … MT-8 commit series) is on V2 and JuryContract. V1 is kept alive by `TaskEscrow.t.sol`, `TaskEscrowLifecycle.t.sol` and `DemoLifecycle`.

### Payout math (both escrows)

Shares are basis points, default 7000/2000/1000 taskor/supplier/jury. The supplier does not get a flat 20%: it gets the `supplierFee` the taskor set in `assignSupplier`, capped at the supplier share. Any unused supplier share (no supplier, or fee below cap) is re-split 70/30 to taskor/jury so nothing stays in escrow. The jury share is transferred to JuryContract and then `notifyReward(juryTaskHash, token, amount)` is called. The escrow must be registered with `jury.setAuthorizedEscrow(escrow, true)` or every finalize reverts. That is deliberate: MT-1 replaced a silent fund black hole with a loud, recoverable misconfiguration.

### V2 validation gating

Community sets per-task requirements with `setTaskValidationRequirement(taskId, tag, minCount, minAvgResponse)` (plus a variant with `minUniqueValidators` and `setTaskAllowedValidators`). Participants attach ERC-8004 request hashes with `addTaskValidationRequest`. `_distributePayments` reads `jury.getValidationStatus` for each request and reverts `ValidationsNotSatisfied` unless every enabled tag meets count, average and unique-validator thresholds. `validationsSatisfied(taskId)` is the view twin for off-chain checks. `docs/VALIDATION-DISPUTE-POLICY.md` maps these into soft (reputation) and hard (challenge) dispute triggers.

### JuryContract is three things in one contract

1. **Jury task voting.** `createTask` → `submitEvidence` → `vote` (active stakers only, score 0–100, conflict-of-interest checks against task creator and SBT owner) → `finalizeTask` once `minJurors` votes or the deadline passes. Average score becomes `finalResponse`; the share of votes at or above `positiveThreshold` (default 50) versus `consensusThreshold` (bps, default 6600) decides COMPLETED vs DISPUTED. An optional `ITaskCallback` is invoked with a 100k gas cap and its failure only emits an event. `agentId = 0` means a context-only task (e.g. purchase dispute) and skips all SBT checks, so MySBT must never mint token id 0. Context fields live in a separate `TaskExtension` mapping that is only written when non-zero.
2. **ERC-8004 Validation Registry.** `validationRequest(validator, agentId, requestUri, requestHash)` requires `validator == address(this)` and, by default, a non-zero `requestHash`. Derive it with `deriveValidationRequestHash(taskId, agentId, validator, tag, requestUri)` (keccak over chainid + those fields) so off-chain and on-chain agree; the orchestrator does exactly that. Any active juror answers with `validationResponse(requestHash, score, responseUri, _, tag)`; a tag can be gated to a role via `setTagRole`. `getSummary` only counts COMPLETED tasks.
3. **Reward pool, pull pattern.** `notifyReward` splits equally among the voters of `taskHash` into `pendingRewards[juror][token]`; remainder (or the whole amount when there are no voters, e.g. an unchallenged V2 task with `juryTaskHash = 0`) accrues to `ownerDust`. Jurors call `claimRewards(token)`; admin `sweepDust`.

Admin switches: `requireJurorRole`, `requireValidationRequesterRole`, `requireNonZeroValidationRequestHash` (on by constructor), `paused`. `DeployLocal`/`DeploySepolia` turn all gating off; `DemoLifecycle` turns it on.

### MySBT

Minimal owner-minted soulbound registry (`ownerOf`, `isRevoked`, role bitmask, `reassign`, `burn`; transfers revert). JuryContract only calls it inside try/catch and only when the address has code, which is why unit tests pass a bare EOA address as `mySBT`. On Sepolia the ecosystem canonical SBT from SuperPaymaster (`0x4867…Aa7`) is used; `DeploySepolia` never deploys a fresh MySBT (decision MT-4).

## Off-chain architecture

- **api-server** (`src/index.ts`, single file). `POST /tasks` is paywalled by `paymentMiddleware` with `price: { amount, asset }` in token atomic units, so any ERC-20 works without USD conversion. The hosted facilitator supports only Base (8453) and Base Sepolia (84532). An idempotency middleware keyed on `keccak256(payment header)` is registered before `paymentMiddleware` so a retried payment never reaches the facilitator twice (the EIP-3009 nonce would be rejected). Receipts live in a bounded in-memory FIFO of 1000; the server does not touch the chain. The client is expected to call `linkReceipt` on the escrow with the returned `receiptId`.
- **agent-mock orchestrator** (`gasless-link-jury-validation.js`). Modes: `linkJuryValidation` (default), `linkReceipt`, `linkReceiptToValidation`, `linkValidationReceipt`, `watchEvidence`, `orchestrateTasks` (watches `TaskCreated` and drives accept → submit → x402 receipts via the proxy → ERC-8004 request/response → link → complete → optional MyShop `buy` reward whose `extraData = abi.encode(taskId, juryTaskHash)`). `--sendMode eoa` (default) or `aa` (SuperPaymaster userOps; needs `BUNDLER_URL`, `SUPER_PAYMASTER_ADDRESS`, `OPERATOR_ADDRESS`, `AA_ACCOUNT_ADDRESS`). State and logs are JSON lines with `ts` + `event`; `taskId` doubles as trace id and is forwarded as `x-trace-id` to the proxy.
- **indexer** (`indexer.js`). Chunked `getLogs` with cursor/resume/confirmations → `out/index.json`; `--serve true` exposes `/tasks /validations /agents /alerts /state /metrics` and `/reputation/:agentId` (canonical JSON + keccak digest, format in `docs/ReputationSnapshot.md`). Optional `--rewardAction` indexes MyShop `RewardIssued` by taskId.
- **x402-proxy** (`x402-proxy.js`). Local stand-in for a facilitator: `POST /pay` writes a receipt under `receipts/`, enforces per-IP/payer/sponsor rate limits and `sponsor-policy.json`, uses atomic JSON writes with corruption recovery.
- **Canonical artifacts.** Receipt and validation payloads are canonicalized with a sorted-key `stableStringify` and ids are `keccak256` of the canonical bytes. The same helper is copied into orchestrator, indexer and api-server; keep them identical. JSON schemas are in `docs/schemas/`.

**Gotcha:** the orchestrator's escrow ABI mixes generations. It calls `submitEvidence`/`completeTask` (V1 only) and `linkReceipt` (V2 only), and the indexer decodes V1 events (`TaskValidated`, `TaskCompleted`, `EvidenceSubmitted`). V1 never had `linkReceipt`. agent-mock predates the V2/MT series, so check the ABI against the contract you actually deployed before trusting a demo run; the README demo flow was written against this hybrid.

## Conventions

- Every `.sol` file: `// SPDX-License-Identifier: Apache-2.0` and `pragma solidity ^0.8.23;`. V2 uses custom errors; V1 and JuryContract use string reverts and tests assert on those exact strings. Match the file you are editing.
- Tests: one `Test` contract per suite, `test_<Function>_<Case>` names, small address literals (`address(0x1)`) for actors, `ERC20Mock` from `test/mocks/`. Invariant tests go through a handler contract. Security fixes come with a test that proves the attack vector (see `test_ChallengeWork_ReentrantStakeToken_BlockedByGuard`).
- Commits: Conventional Commits with a scope (`contracts`, `deploy`, `api-server`, `jury`), body in Chinese, and the `MT-n` tracker id for review-series work. PRs need a CLA signature (cla-assistant bot) and CODEOWNERS approval.
- CI exists only for contracts (`contracts/.github/workflows/test.yml`: `forge fmt --check`, `forge build --sizes`, `forge test -vvv`). Nothing lints or tests the TS/JS packages.
- Keys: `DeployLocal` and `Deploy.s.sol` hardcode the anvil burn key by design; `DeploySepolia` requires `DEPLOYER_PRIVATE_KEY` from env. Keep that split.
