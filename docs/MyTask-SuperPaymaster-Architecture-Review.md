# MyTask × SuperPaymaster 架构评审：冗余、共用与优化方向

- 日期：2026-10-11
- 范围：MyTask（本仓库 HEAD 43d76e7）、SuperPaymaster（Registry-5.8.0 / SuperPaymaster-5.4.2，Sepolia）、aastar-sdk（v0.24.x）、MyShop（main）
- 方法：逐文件阅读 + Sepolia 链上 `cast call` 核实。标注「已核实」的项为本次直接验证；标注「推断」的项为基于代码阅读的判断。

## 0. 结论先行

MyTask 当前是一个**自给自足的孤岛**：身份（MySBT）、角色与质押（JuryContract 内置）、ERC-8004 验证账本（JuryContract 内置）、x402 结算（Coinbase facilitator + 本地 mock proxy）、AA 发送（agent-mock 手写 userOp）全部自行实现。而同级目录 SuperPaymaster 生态在 Sepolia 上已经部署并被 SDK 封装了**同一类能力的正式版本**。重叠面约为 MyTask 合约代码的 40%、链下代码的 60% 以上。

| 能力 | MyTask 自建 | 生态已有（Sepolia 已上线） | 判定 |
|---|---|---|---|
| 身份 SBT | `contracts/src/MySBT.sol`（owner mint，角色位图） | 生态 canonical MySBT `0x4867…Aa7`（ERC-721，Registry 联动）；ERC-8004 IdentityRegistry `0x8004A8…`（官方部署，UUPS） | **删除自建**，MT-4 已决定一半 |
| 角色 + 质押 + 退出冷却 | `JuryContract.registerJuror/unregisterJuror`、`ROLE_JUROR/ROLE_VALIDATION_REQUESTER`、tag→role | `Registry.registerRole/exitRole/configureRole` + `GTokenStaking`（lock、ticket、exit fee、`slash`、authorized slasher）；`ConfigureMyTaskRoles.s.sol` 已定义 JURY/PUBLISHER/TASKER/SUPPLIER | **迁移到 Registry**，JuryContract 只读 `hasRole`/`getEffectiveStake` |
| ERC-8004 Validation Registry | `JuryContract` 自身实现（`validatorAddress` 必须等于合约自己） | 官方 ValidationRegistry `0x8004Cb…`（已核实：`getAgentValidations(1)` 返回真实 requestHash，ABI 与 `IERC8004ValidationRegistry.sol` 完全一致） | **JuryContract 降级为 validator**，账本用官方合约 |
| 信誉 | `agent-mock/indexer.js` 链下快照 + `JuryContract.getSummary` | `ReputationSystem.sol`、`Registry.setReputationSource/getCreditLimit`、官方 ReputationRegistry `0x8004B6…`（`giveFeedback`） | 把验证结果**写回生态信誉源**，撤掉自算 |
| x402 结算 | `packages/api-server`（Coinbase facilitator，仅 Base）、`agent-mock/x402-proxy.js`（mock） | `X402Facilitator.sol` `0xfe1D…`（EIP-3009 + xPNTs 直付）、SDK `@aastar/x402`（`X402Client`、`FacilitatorClient`、dvt1-3.aastar.io/x402） | **换生态 facilitator**，删 mock proxy |
| AA / gasless 发送 | `agent-mock` 手写 `getNonce/getUserOpHash/execute` + paymaster 字段 | SDK `PaymasterClient.submitGaslessUserOperation`、`EndUserClient.executeGasless` | **用 SDK** |
| 合约基础件 | 手写 owner/pause/reentrancy，`require(token.transfer())` | OZ v5（Ownable、Pausable、ReentrancyGuard、SafeERC20）+ solady | 引入 OZ |
| 托管 | `TaskEscrow`（V1）与 `TaskEscrowV2` 并存，ABI 不互通 | — | 退役 V1 |

## 1. 链上事实（已核实，Sepolia，2026-10-11）

| 项 | 结果 |
|---|---|
| Registry `0xf5Bf…8E71` 版本 | `Registry-5.8.0` |
| `getRoleConfig(keccak("JURY"/"PUBLISHER"/"TASKER"/"SUPPLIER"))` | 全部为零值、`isActive=false`、用户数 0。**TotalSolution M2「四角色 Registry 配置上线」未执行** |
| `COMMUNITY` / `ENDUSER` | 已激活，分别 5 / 3 个用户，minStake 30 GT / 0.3 GT |
| MyTask JuryContract `0x63f3…` → `getMySBT()` | `0x4867…Aa7`（生态 canonical SBT） |
| `authorizedEscrows(0x1712…)` | `true`（MT-1 修复已生效） |
| SuperPaymaster `0x09DF…` `agentIdentityRegistry()` / `agentReputationRegistry()` | `0x8004A8…` / `0x8004B6…`（官方 ERC-8004 地址） |
| `0x8004A8…` `name()/symbol()` | `AgentIdentity` / `AGENT`；`isRegisteredAgent(address)` **revert**（官方 IdentityRegistry 没有该函数） |
| `0x8004Cb…` ValidationRegistry | EIP-1967 proxy，实现 `0xdb31…`；`getAgentValidations(1)` 返回 1 条 |

两个连带发现：

1. **SuperPaymaster 侧**：`isRegisteredAgent` 走 `try/catch`，对官方 IdentityRegistry 调用必然 revert → Agent 赞助通道在 Sepolia 上实际是关闭的（`sbtHolders[user] || isRegisteredAgent(user)` 退化为仅 SBT）。SP 的 `IAgentIdentityRegistry` 接口是为自家 Mock 设计的，与官方 ERC-721 接口不一致。这不是 MyTask 的问题，但影响下文「Agent 身份统一」方案。
2. **MyTask 侧**：`JuryContract` 的 `IMySBT` 要求 `ownerOf + isRevoked`；canonical MySBT 是 OZ ERC-721，有 `ownerOf` 但**没有 `isRevoked`**。因为包在 `try/catch` 里，撤销检查在 Sepolia 上是静默失效的。

## 2. 逐项冗余分析

### 2.1 身份：三套 agentId 语义并存

- `JuryContract.agentId` = canonical MySBT 的 tokenId（每个地址一枚，`getUserSBT(user)`）。
- SuperPaymaster 赞助判定用 ERC-8004 IdentityRegistry 的 `agentId`（另一个 ERC-721 的 tokenId）。
- MyTask 自带 `MySBT.sol` 还有第三套 `rolesOf` 位图（TASKOR/SUPPLIER/JUROR/VALIDATION_REQUESTER），链上无人读取。

后果：`validationRequest(agentId)` 写进 JuryContract 的「验证历史」无法被 SuperPaymaster 的信誉/信用额度体系消费，反之亦然。

### 2.2 角色与质押：JuryContract 重做了 Registry 的子集

| 维度 | JuryContract | Registry + GTokenStaking |
|---|---|---|
| 质押资产 | 任意 ERC-20（部署用 mock xPNT） | GToken，统一金库 |
| 进入 | `registerJuror(stake)` ≥ `minJurorStake` | `registerRole(roleId, user, roleData)`：minStake + ticketPrice（销毁）|
| 退出 | 7 天硬编码冷却 | `roleLockDuration` + `exitFeePercent/minExitFee`，可按角色配置 |
| 惩罚 | `Vote.slashed` 字段存在但**没有任何 slash 实现** | `GTokenStaking.slash(user, amount, reason)`，`setAuthorizedSlasher` |
| 权限 | `grantRole` 由 admin 单点控制 | `configureRole.owner` 角色级 owner + timelock |

JuryContract 的 「crypto-economic jury」目标（README 的 stake-weighted voting、slashing）在生态里已经有金库和 slasher 钩子，自建版本反而缺功能。

### 2.3 ERC-8004：账本和验证者混在一个合约

官方模型：ValidationRegistry 是**公共账本**，任意 `validatorAddress`（合约或 EOA）向它写 `validationResponse`。MyTask 把账本内置进 JuryContract，并强制 `validatorAddress == address(this)`，于是：

- 其他验证者（TEE、zk、另一家陪审团）无法为同一 agent 写入；
- `TaskEscrowV2._requireValidationsSatisfied` 只认 JuryContract 的状态，`setTaskAllowedValidators` 形同虚设；
- SuperPaymaster/信誉系统读的是 `0x8004Cb…`，看不到 MyTask 的验证。

### 2.4 x402：三个回执存储、两条链

- api-server：内存 FIFO（1000 条），facilitator 固定 Coinbase（Base / Base Sepolia）；
- x402-proxy：本地 JSON 文件；
- 链上：`TaskEscrowV2.linkReceipt` 只存 `receiptId`。

任务在 Sepolia，支付却只能在 Base Sepolia，回执无法在链上互证。生态 `X402Facilitator.settleX402Payment` 返回 `settlementId = keccak(from,to,asset,amount,nonce)` 并发 `X402PaymentSettled` 事件，天然就是可验证的 `receiptId`。

### 2.5 链下：agent-mock 与 SDK 重复，且与合约脱节

- 手写 userOp 构造 ≈ `PaymasterClient` 已封装的 L3 场景；
- `mock-run2.sh` 引用的 `aastar-sdk/examples/agent-mock-mytask-gasless.ts` 在 SDK 仓库中不存在；
- orchestrator 的 escrow ABI 混用 V1（`submitEvidence/completeTask`）与 V2（`linkReceipt`）选择器；indexer 解码 V1 事件；
- README 声称的 MyShop `RewardAction` / `RewardIssued(taskId, juryTaskHash, …)` 在 MyShop main 分支不存在，indexer 实际解码的是 `EmitEventAction.ActionEvent`。

## 3. 同类开源设计对照

| 设计 | 要点 | 对 MyTask 的启示 |
|---|---|---|
| **ERC-792 / Kleros**（IArbitrator / IArbitrable） | 托管（arbitrable）与法庭（arbitrator）通过标准接口解耦：`createDispute(choices, extraData)` + `rule(disputeId, ruling)` 回调；上诉、仲裁费由 arbitrator 定义 | MyTask 已有 `ITaskCallback.onTaskFinalized` 雏形，但 Escrow 对 JuryContract 是硬依赖（`immutable juryContract` + 读 `IJuryContract.Task`）。改为 ERC-792 风格后，JuryContract、Kleros、UMA 可互换 |
| **UMA Optimistic Oracle V3** | `assertTruth` 带 bond + liveness；`disputeAssertion` 需等额 bond；争议升级到 DVM；`EscalationManager` 可插拔；`assertionResolvedCallback` | TaskEscrowV2 的 submit → 3 天挑战期 → 陪审 正是 OOv3 模式。差距：V2 只有 community 能挑战、挑战者押金固定、败诉方押金去向写死；OOv3 的「任何人可挑战、双边对称 bond、胜者得对方 bond」更抗合谋 |
| **Aragon Court / Celeste** | 陪审员按质押**抽签**（sortition）、**commit-reveal** 投票、多轮上诉、少数派 slash | JuryContract 投票公开可见（`vote` 直接写分数），存在从众与贿赂风险；没有抽签，任何活跃 juror 都可投，`minJurors` 只是下限；`slashed` 无实现 |
| **ERC-8004 官方三件套 + EAS** | Identity（ERC-721）、Reputation（`giveFeedback`）、Validation（request/response）彼此独立；EAS 以 schema attestation 表达验证 | 验证结果应写进公共账本并回流信誉，而不是锁在应用合约里 |
| **StandardBounties（Bounties Network）** | issuer / fulfiller / approver 分离，多个 fulfillment，approver 可是合约 | Supplier 作为「可选第四方」在 MyTask 是合理扩展；但 approver 应可配置（community 自批、陪审、oracle） |
| **OpenZeppelin v5** | `Ownable2Step`、`Pausable`、`ReentrancyGuard`、`SafeERC20` | SuperPaymaster 已依赖 OZ v5.0.2，MyTask 应直接复用同一版本，避免 USDT 类非标准 ERC-20 的 `transfer` 返回值问题 |

## 4. 目标架构（建议）

```
L4  Agent / 编排      aastar-sdk（PaymasterClient, X402Client, registryActions）+ 薄的 mytask orchestrator
L3  支付              X402Facilitator(0xfe1D…) / 托管 facilitator(dvt1-3) ；settlementId == receiptId
L2  结算              TaskEscrowV2（唯一托管）：乐观挑战期 + IArbitrator 可插拔
L1  验证 / 信誉       官方 ValidationRegistry(0x8004Cb…) ← JuryContract 作为 validator 写入
                      ReputationRegistry(0x8004B6…) / Registry.setReputationSource 回流
L0  身份 / 角色 / 质押 Registry(JURY/PUBLISHER/TASKER/SUPPLIER) + GTokenStaking + canonical MySBT + IdentityRegistry(0x8004A8…)
```

### 4.1 合约层

1. **删除 `MySBT.sol`**（MT-4 的后半步）。JuryContract 的 `IMySBT` 改为 `IERC721.ownerOf` + `Registry.hasRole`；撤销语义用 `Registry.hasRole(ROLE_TASKER, owner)` 代替 `isRevoked`。
2. **JuryContract 去掉质押与角色**：删 `registerJuror/unregisterJuror/_jurorStakes/grantRole/setTagRole`；`vote`/`validationResponse` 的准入改为 `REGISTRY.hasRole(ROLE_JURY, msg.sender)`；slash 通过 `GTokenStaking.slash`（JuryContract 注册为 authorized slasher，或走 DVT/BLS 共识路径）。需要先在 Sepolia 执行 `ConfigureMyTaskRoles.s.sol`。
3. **JuryContract 拆成两部分**：
   - `JuryCourt`（arbitrator）：createTask / vote / finalize，实现 ERC-792 风格 `IArbitrator`；最终裁决既回调 Escrow（`rule`），也向 `0x8004Cb…` 写 `validationResponse`（JuryCourt 就是 `validatorAddress`）。
   - 删除内置 Validation Registry（`validationRequest/getValidationStatus/getSummary/_agentValidations`）。
4. **TaskEscrowV2**：`juryContract` 改为可配置的 `IArbitrator`；`_requireValidationsSatisfied` 读 `0x8004Cb….getValidationStatus`；挑战改为对称 bond（挑战者与 taskor 各押一份，败方 bond 归胜方，参考 OOv3）；引入 OZ `SafeERC20/Pausable/Ownable2Step/ReentrancyGuard`。
5. **退役 `TaskEscrow`（V1）**：迁移 `TaskEscrowLifecycle.t.sol` 与 `DemoLifecycle` 到 V2。
6. **信誉回流**：finalize 时向 ReputationRegistry `giveFeedback(agentId, score, …, tag1=TASK, tag2=taskType)`，并把 JuryCourt 注册为 `Registry.setReputationSource`，让 MyTask 结果影响 SuperPaymaster 的信用额度。
7. **MyShop 奖励**：以 `EmitEventAction.ActionEvent(extraData = abi.encode(taskId, juryTaskHash))` 为准更新文档与 indexer；如需强绑定，在 MyShop 增加专用 action，而不是在 MyTask README 里声明不存在的合约。

### 4.2 支付与链下

1. **api-server** 换 `@aastar/x402`：`FacilitatorClient({ url: dvt1.aastar.io/x402 })` + `getX402FacilitatorContract(11155111)`；回执改为 `settlementId`，并在 `POST /tasks` 后由 server 直接调用 `linkReceipt`（或返回给客户端）。删除内存 FIFO 和 `x402-proxy.js`。
2. **agent-mock 瘦身**：删除手写 userOp/paymaster 代码，改用 `PaymasterClient.submitGaslessUserOperation`；Registry/SBT 读写用 `registryActions/sbtActions`。
3. **新增 `@aastar/mytask`（或 SDK 内 `packages/task`）**：vendored `TaskEscrowV2.json/JuryCourt.json` ABI + `escrowActions/juryActions`，纳入 SDK 的 ABI 覆盖率检查（`check-doc-coverage.ts`），结束「orchestrator ABI 与合约脱节」的问题。
4. **indexer**：只保留 V2 事件 + `X402PaymentSettled` + `ValidationResponse(0x8004Cb…)` + `ActionEvent`；信誉快照改为读 ReputationRegistry/`getCreditLimit`。

## 5. 迁移顺序与风险

| 阶段 | 内容 | 前置 | 风险 |
|---|---|---|---|
| P0（1 周） | 在 Sepolia 执行 `ConfigureMyTaskRoles.s.sol`；修复文档与 agent-mock ABI 不一致；api-server 切换到生态 facilitator | 需要 Registry owner 签名 | 低 |
| P1（2 周） | JuryContract 去质押/去角色，读 Registry；删 `MySBT.sol`；引入 OZ；退役 V1 | P0 | 中：JuryContract 测试（1081 行）大半要改 |
| P2（2–3 周） | 拆 JuryCourt + 官方 ValidationRegistry；Escrow 改 `IArbitrator`；对称 bond | P1；需确认 `0x8004Cb…` 对 `validatorAddress` 为合约的支持（ERC-8004 允许） | 中高：重新部署 + 重新审计 MT-1/MT-2 修复点 |
| P3 | 信誉回流、`@aastar/mytask` SDK 包、indexer 重写 | P2 | 低 |

跨仓库待办（非 MyTask 范围，但阻塞 L0 统一）：SuperPaymaster 的 `isRegisteredAgent` 需适配官方 IdentityRegistry（`balanceOf(account) > 0`），否则 Agent 身份通道无法作为 MyTask Taskor 的准入依据。

## 6. 不建议改的部分

- TaskEscrowV2 的乐观挑战期、ERC-20 挑战押金（AA 友好）、fee-on-transfer 记账、`notifyReward` 的 pull 模式：这些是 MT 系列审计修复的结果，方向正确，保留。
- 70/20/10 + 未用 supplier 份额 70/30 再分配：语义清晰，保留；但 shares 应改为按任务（`createTask` 参数）而非合约全局，这在 TotalSolution §8 已被列为风险。
- `deriveValidationRequestHash` 含 chainid 的确定性 requestHash：与官方 ValidationRegistry 兼容，保留。
