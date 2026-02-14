# MyTask Product Roadmap + PRD + Technical Design (Onchain Tasks + Agent Economics)

Last updated: 2026-02-14

## 0) What I reviewed in `docs/` (inputs to this doc)

This roadmap is synthesized from the existing documents in `docs/`, especially:

- `TotalSolution.md`: cross-repo end-to-end flow (Registry/MySBT/Paymaster, MyTask escrow+jury, MyShop items+actions, external agent).
- `REFERENCE-ARCHITECTURE-SYNTHESIS.md` + `ARCHITECTURE-DECISION-RECORDS.md`: 5-layer architecture and key decisions (x402, facilitator pattern, LangGraph, etc.).
- `PayBot-Core-Abstraction-Analysis.md`: facilitator pattern + escrowed micropayments (gasless UX).
- `PayloadExchange-Analysis.md`: x402 proxy + sponsored payments + ZK/webproof audit trails.
- `ZKx402-NextGen-Protocol-Analysis.md`: privacy-preserving authorization + ERC-8004 agent authorization patterns.
- `HubbleAITrading-Integration-Solution.md`: multi-agent runtime framing and “ERC-8004 + x402” discovery/payment.
- `x402-3009-8004.md`: background notes around EIP-3009 (transferWithAuthorization).
- `Halo-Decentralized-Infrastructure-Analysis.md`: decentralized offline verification primitives (OCR/storage/human proof).

Note: the repository code index is currently not ready in the IDE, so this synthesis is based on direct file reading + targeted searches.

## 1) Product Vision

Build a full-stack protocol and product where:

- **Onchain task lifecycle** is trust-minimized (escrow, roles, disputes, settlement).
- **Agents are first-class economic actors**: they can discover resources, pay (or get sponsored), request/produce validations, and build reputation.
- **Payments are web-native**: agents can pay for APIs/data/tools via **x402**, with optional sponsorship.
- **Validations are standardized**: verification requests/responses are tracked via **ERC-8004 / EIP-8004 Validation Registry** semantics and can be referenced by task settlement.

## 2) Problem Statement

Current state: MyTask has a usable onchain task escrow + a jury contract and an agent-mock helper.

Missing for a complete “agent economy” product:

- A standard way for agents to **buy compute/data/tools** (x402), with **accounting** and **policy** (budgets, approvals, sponsorship).
- A consistent way to **measure agent quality** (validation history, reliability, slashing conditions, reputation scores).
- A composable interface for agents and validators to **request and return validations** (ERC-8004 registry mapping to MyTask settlement).

## 3) Target Users & Personas

- **Community / Publisher**: funds tasks, wants predictable cost, wants reliable agent outcomes.
- **Taskor / Tasker**: executes tasks, wants fair pay, wants fast validation & dispute resolution.
- **Supplier (resource provider)**: provides data/compute/tools/services, wants paid quickly, wants demand.
- **Juror / Validator**: audits outcomes, wants incentives, wants anti-sybil and reputation.
- **Agent Operator**: runs an autonomous agent that completes tasks, buys tools via x402, and builds reputation.
- **Facilitator / Paymaster Operator**: sponsors gasless UX and/or x402 sponsorship, wants revenue covering costs.

### 3.1 Validator vs Jury (role boundaries)

- **Validator** is an abstract role: any entity that can produce a validation result that can be audited/attributed (human expert, oracle, ZK/TEE verifier, DAO committee, automated judge, etc.). The output is a signed/onchain record that can be aggregated into reputation (ERC-8004 semantics: request → response + tag + score).
- **Jury** is one validator implementation optimized for disputes and subjective judgments: a juror set with staking + voting + consensus rules that yields one final result. Jury is slower and more expensive, but supports strong accountability (e.g., slashing) and “final decision” semantics.
- **Not duplicate**: Validator is the interface/capability layer; Jury is a plugin implementation. The recommended model is “many validators exist; Jury is one validator type”. Task settlement can require either:
  - one Jury result, or
  - N independent validators, or
  - a hybrid (e.g., automated checks first, jury only on conflicts).
  
- **Rule of thumb**:
  - Objective / automatable / provable: prefer Validator (automation/ZK/TEE/webproof).
  - Subjective / dispute-prone / needs final arbitration: prefer Jury.

### 3.2 Taskor vs Agent (identity and wallets)

- **Taskor** is a task execution role in the escrow: it is simply an onchain account that accepts tasks and gets paid.
- **Agent** is an economic actor that can execute tasks and also spend budget via x402 and accumulate reputation. In practice, an agent is a **software-controlled account** (EOA or smart account) operated by a human/organization.
- Recommended mapping:
  - One agent = one onchain account (wallet / AA account) + one `agentId` (reputation identifier).
  - A single human/organization may operate multiple agents (multiple wallets / agentIds).
  - The same account can be both Taskor and Agent; **but** add conflict-of-interest policy: jurors/validators must not validate tasks where they are participants (taskor/supplier/community) or where the agentId matches the executor.

## 4) PRD (Product Requirements)

### 4.1 Core Jobs-To-Be-Done

- Create a task with escrowed reward and explicit acceptance criteria.
- Allow task acceptance, work submission, and evidence linking.
- Trigger validation (jury/validators) with verifiable audit trail.
- Settle payout automatically after validation completion.
- Let agents pay for external resources (APIs, datasets, tools) via x402, with optional sponsorship and budgets.
- Produce a durable reputation/validation history for agents and validators.

### 4.2 Functional Requirements (MVP)

**Onchain task system (already present, must remain stable)**

- Task lifecycle states: created → accepted → submitted → validated → completed.
- Supplier involvement is optional; supplier payout is capped by supplier share.
- Settlement produces deterministic payouts.

**Agent economics system (new “product layer”)**

- Agent identity: map a stable **agentId** to onchain identity (SBT / registry).
- Validation history: an ERC-8004 compatible validation registry for:
  - requesting validation with a request URI/hash,
  - submitting a response with response URI/hash + tag + score,
  - querying per-agent summaries.
- Policies:
  - budget limits for x402 spend per agent and per task,
  - whitelists/blacklists for x402 resources,
  - minimum validation requirements before settlement (per task type).
- Incentives:
  - juror reward distribution and optional additional rewards (points/NFT via Items+Actions),
  - slashing (or stake lock/penalty) rules for jurors/agents under disputes or fraudulent validations.

**x402 integration (web payments)**

- A gateway service that:
  - can buy resources on behalf of an agent (x402 client),
  - can act as a proxy to allow sponsorship flows (community-funded x402 payments),
  - emits auditable receipts (webproof/zk proofs optional).
- Support at least one stablecoin rail for payment authorization:
  - ERC-2612 Permit and/or EIP-3009 transfer authorization (token-dependent),
  - AA gasless submission where available (Paymaster/Bundler integration).

### 4.3 Non-Functional Requirements

- **Auditability**: every validation and every paid resource access is attributable to an agentId and a taskId (directly or via receipt).
- **Safety**: spend limits, replay protection, time windows on signatures.
- **Privacy controls**: allow storing only hashes onchain; full evidence and receipts offchain (IPFS/HTTP).
- **Extensibility**: new resource types and validators can be integrated without contract upgrades where possible.

### 4.4 Success Metrics (MVP)

- Task completion rate and median time-to-validated.
- Cost predictability: variance between estimated vs realized x402 spend per task.
- Validation quality: correlation between validator scores and disputes.
- Agent reliability: repeat completion rate over N tasks without disputes.

## 5) Technical Design (System Architecture)

### 5.1 High-Level Components

**Onchain**

- `TaskEscrow` (MyTask): holds task funds, manages task lifecycle, settles payouts.
- `JuryContract` (MyTask): juror staking/registration + jury tasks; as a validator implementation, can be adapted to ERC-8004 Validation Registry semantics.
- Identity / roles: MySBT + Registry/role system (cross-repo per `TotalSolution.md`).

**Offchain**

- **Agent Orchestrator**: listens to onchain events, drives task execution workflows, stores evidence/receipts, requests validations.
- **x402 Gateway**:
  - resource proxy (handles 402 challenge/response),
  - sponsorship engine (community budgets),
  - receipt store (hashes + metadata).
- **Indexing + Storage**:
  - minimal indexer (events → DB),
  - IPFS (evidence, validation reports, receipts) or a blob store.

### 5.2 Key Flows

#### Flow A: Task lifecycle + jury validation (today)

1) Community creates task (escrowed reward).
2) Taskor accepts and submits evidence.
3) External agent (or community) triggers jury process and links a completed jury task to the escrow.
4) Escrow settles payouts.

#### Flow B: Agent buys tools/data via x402 for a task (new)

1) Agent sees a task requiring external data/compute/tool.
2) Agent requests resource from an x402-protected endpoint.
3) x402 Gateway handles `402 Payment Required` and either:
   - pays using agent budget, or
   - routes sponsorship: community pays in exchange for actions/data policy.
4) Gateway stores a receipt (and optional ZK/webproof) and returns resource to agent.
5) Receipt hash is attached to task evidence URI or to validation request URI.

#### Flow C: ERC-8004 validation registry as the “reputation substrate” (new)

1) Agent (or orchestrator) emits a validation request referencing:
   - taskId, evidence URI, receipts, evaluation rubric.
2) Validator/jurors submit responses with:
   - a score (0-100), tag (category), response URI/hash.
3) Reputation queries aggregate per agentId (counts, average scores, per tag).
4) MyTask settlement policy uses “minimum validations achieved” gates (by task type).

### 5.3 Data Model (canonical identifiers)

- `taskId` (bytes32): primary task identifier in MyTask.
- `agentId` (uint256): primary agent identifier for validations and economics.
- `requestHash` (bytes32): validation request identifier (deterministic if possible).
- `x402ReceiptId` (bytes32): hash of normalized payment receipt payload.

### 5.4 Economics Model (defaults, configurable)

**Payouts**

- Base task reward is escrowed by Community.
- Settlement splits into:
  - Taskor payout,
  - Supplier payout (optional, capped),
  - Jury payout.

**Agent spend**

- Each task has an optional “tool/data budget”.
- x402 spend is deducted from:
  - task budget (community-funded), and/or
  - agent wallet (operator-funded), and/or
  - sponsor pool (community-funded with policy constraints).

**Fees**

- Facilitator/x402 gateway charges a fee:
  - to cover gas/ops,
  - plus a configurable margin.

**Reputation and penalties**

- Validators/jurors build reputation through accepted validations.
- Disputes can trigger:
  - stake slashing (jurors) or reputation penalties,
  - agent reputation penalty if fraudulent evidence is proven.

## 6) Roadmap (Milestones)

### Milestone 0: “Onchain lifecycle demo” (Done)

- End-to-end demo script exists and can run on anvil.
- Tests pass for TaskEscrow, JuryContract, and lifecycle integration.
- Deployment flow derives the actual on-chain `taskId` (prevents taskId mismatch).
- MySBT-backed `enforceAgentOwner` is enabled (validations are strictly owner-bound).
- ERC-8004 determinism is locked by requiring `requestHash != 0` (end-to-end demo + tests).
- M5 reward trigger is wired in `orchestrateTasks` using an EOA payer and shows up in indexer state.

### Milestone 1: “ERC-8004-first agent reputation”

- Standardize the validation registry usage as the core reputation primitive.
- Make task settlement optionally require a set of validation tags and thresholds.

### Milestone 2: “x402 spend + receipts”

- Add an x402 gateway that can pay and store receipts.
- Attach receipts to tasks and validation requests so every paid resource is auditable.

### Milestone 3: “Agent economics policies”

- Budgets, sponsor pools, and policy engine (allowed endpoints, spend caps, per-task constraints).
- Dashboards for spend and performance per agentId.

### Milestone 4: “Production hardening”

- Security reviews, invariant tests, incident playbooks.
- Rate limits and abuse prevention for x402 proxy and validators.

## 7) Engineering Task Breakdown (Epics → Tasks)

### Epic A: Standardize validations (ERC-8004 / EIP-8004)

- Define canonical request/response JSON schemas for `requestUri` and `responseUri`.
- Add task policies: required tags, minimum count, minimum average score.
- Add event indexer for validation events and per-agent aggregates.
- Add dispute triggers mapping (when validation conflicts, what is slashable and how).

### Epic B: x402 gateway and receipts

- Implement x402 client module (agent-side) and proxy module (sponsor-side).
- Implement receipts:
  - normalization,
  - hashing,
  - storage (IPFS/DB),
  - linking to task evidence.
- Implement sponsor flow:
  - match sponsorship rules (actions/data),
  - budget accounting and reporting.

### Epic C: Agent runtime and orchestration

- Implement event-driven orchestrator that:
  - watches task lifecycle events,
  - triggers agent execution,
  - requests validations,
  - submits onchain links/settlement.
- Add “manual override / human-in-the-loop” checkpoints for high-risk tasks.

### Epic D: Identity and roles (MySBT / registry)

- Define agent identity lifecycle:
  - mint/assign agentId,
  - role gating for validators/jurors,
  - sybil resistance options.
- Add role-based permissions for who can request/answer certain validation tags.

### Epic E: UI + Observability

- Build role dashboards:
  - tasks, validations, disputes,
  - x402 spend and receipts,
  - per-agent reputation.
- Add structured logs and traces for the gateway and orchestrator.

## 8) Open Questions (must decide early)

- What is the canonical “agentId” source of truth (SBT tokenId vs registry mapping vs derived)?
- Which payment authorization rails are mandatory for MVP:
  - ERC-2612, EIP-3009 (token-specific), or AA-only?
- What is the minimum viable dispute model:
  - “soft disputes” (reputation-only) vs “hard disputes” (slashing + onchain arbitration)?
- Where do receipts live and what is posted onchain (hash-only vs full URIs)?

---

# MyTask 产品路线图 + PRD + 技术设计（链上任务 + Agent 经济系统）

最后更新：2026-02-13

## 0）我在 `docs/` 里审阅了什么（本文输入）

本路线图与设计稿是基于 `docs/` 目录中的现有材料综合整理，重点参考：

- `TotalSolution.md`：跨仓库端到端闭环（Registry/MySBT/Paymaster、MyTask escrow+jury、MyShop items+actions、外部 agent）。
- `REFERENCE-ARCHITECTURE-SYNTHESIS.md` + `ARCHITECTURE-DECISION-RECORDS.md`：5 层架构与关键决策（x402、facilitator 模式、LangGraph 等）。
- `PayBot-Core-Abstraction-Analysis.md`：facilitator 模式 + 托管式微支付（gasless 体验）。
- `PayloadExchange-Analysis.md`：x402 代理 + 赞助支付 + ZK/webproof 审计轨迹。
- `ZKx402-NextGen-Protocol-Analysis.md`：隐私友好的授权 + ERC-8004 代理授权模式。
- `HubbleAITrading-Integration-Solution.md`：多代理运行时与 “ERC-8004 + x402” 的发现/支付框架。
- `x402-3009-8004.md`：EIP-3009（transferWithAuthorization）背景记录。
- `Halo-Decentralized-Infrastructure-Analysis.md`：去中心化离线验证原语（OCR/存储/真人证明）。

注：目前 IDE 的仓库代码索引尚未就绪，因此该综合稿基于逐文件阅读与定向检索完成。

## 1）产品愿景

打造一个全栈协议与产品，使得：

- **链上任务生命周期** 尽可能去信任化（托管、角色、争议、结算）。
- **Agent 成为一等经济参与者**：可发现资源、支付（或被赞助）、发起/产出验证、沉淀声誉。
- **支付以 Web 为原生载体**：Agent 通过 **x402** 直接为 API/数据/工具付费，并支持赞助模式。
- **验证标准化**：验证请求/响应以 **ERC-8004 / EIP-8004 Validation Registry** 语义进行记录，并可被任务结算引用。

## 2）问题陈述

现状：MyTask 已具备可用的链上任务托管（TaskEscrow）+ 陪审合约（JuryContract）以及 agent-mock 辅助脚本。

要成为完整的 “Agent Economy” 产品，还缺少：

- Agent **购买算力/数据/工具** 的标准方式（x402），以及配套 **记账** 与 **策略**（预算、审批、赞助）。
- 衡量 **Agent 质量** 的一致方法（验证历史、可靠性、惩罚/罚没条件、声誉分）。
- Agent 与验证者之间 **可组合的验证接口**（ERC-8004 registry，且能映射到 MyTask 的结算门槛）。

## 3）目标用户与画像

- **Community / Publisher**：出资发布任务，追求成本可预测与结果可靠。
- **Taskor / Tasker**：执行任务，追求公平报酬与快速验收/纠纷处理。
- **Supplier（资源提供方）**：提供数据/算力/工具/服务，追求快速回款与持续订单。
- **Juror / Validator**：验证与仲裁，追求激励、抗女巫、可积累声誉。
- **Agent Operator**：运营自动化 agent，完成任务、用 x402 购买工具、积累声誉。
- **Facilitator / Paymaster Operator**：提供 gasless 体验与/或 x402 赞助清算，追求可持续收入覆盖成本。

### 3.1（中文版）Validator 与 Jury（陪审）有什么区别？是否重复？

- **Validator（验证者）** 是“输出验证结论”的抽象角色：任何能对某个验证请求给出可被复核/追责的验证结果的主体都算验证者（人类专家、预言机、ZK/TEE 验证器、DAO 委员会、自动化 judge 等）。其输出形态是可被链上记录与聚合的结果（ERC-8004 语义：request → response + tag + score），用于声誉沉淀与任务结算门槛。
- **Jury（陪审团）** 是“处理争议/主观判断”的验证者实现：由一组 juror（质押 + 投票 + 共识阈值）产出一个最终结论，通常更慢、更贵，但适合主观性强、欺诈空间大、或对赔付/罚没有强约束的任务。
- **是否重复？不重复**：Validator 是接口层/能力层；Jury 是其中一种插件化实现，偏向“强约束 + 可惩罚 + 最终裁决”。系统还可以并行支持更便宜的验证者（自动校验、ZK/webproof、可信硬件证明等）。
- **推荐的统一设计**：把 Jury 当作“验证者的一种类型”，并把结算条件表达为可组合策略：
  - 只要 1 次陪审结果；
  - N 个独立验证者结果；
  - 混合模型（先自动校验；出现冲突、边界情况或高风险阈值时升级到陪审）。
- **设计取舍（快速判断）**：
  - 更客观、可自动化、可生成 proof：优先 Validator（自动/ZK/TEE/webproof）。
  - 更主观、易争议、需要最终裁决与 slashing：优先 Jury。

### 3.2（中文版）Taskor 是否可以同时也是 Agent？Agent 究竟是什么？

- **Taskor** 是任务托管里的“执行者角色”，在链上表现为一个接单并收款的账户地址。
- **Agent** 是引入“agent 经济系统”后的一类经济主体：除了执行任务，还会通过 x402 购买工具/数据并累积声誉。落地上，Agent 通常是“由人/组织运营的一套 AI/自动化系统”，其链上身份是一个 **钱包账户（EOA 或 AA 智能账户）**。
- 推荐映射关系：
  - 一个 agent = 一个链上账户（wallet / AA account） + 一个 `agentId`（声誉标识）。
  - 一个自然人/组织可以运营多个 agent（多个钱包 / 多个 agentId）。
  - 同一个账户可以同时是 Taskor 与 Agent；但要加 **利益冲突规则**：juror/validator 不能验证自己参与的任务（community/taskor/supplier 任一参与方），也不能验证与自身 agentId 对应的执行结果。

## 4）PRD（产品需求）

### 4.1（中文版）核心任务（JTBD）

- 创建任务：托管奖励资金，并明确验收标准。
- 支持接单、提交交付物/证据与证据链接。
- 触发验证（陪审/验证者），并提供可审计轨迹。
- 验证完成后自动结算分账。
- Agent 可通过 x402 支付外部资源（API/数据/工具），并支持赞助与预算。
- 为 agent 与验证者沉淀可持续的声誉/验证历史。

### 4.2（中文版）MVP 功能需求

**链上任务系统（已存在，必须保持稳定）**

- 任务状态：created → accepted → submitted → validated → completed。
- Supplier 可选参与；supplier 的可分配金额受 supplier share 上限约束。
- 结算分账结果确定、可复现。

**Agent 经济系统（新增“产品层”）**

- Agent 身份：将稳定的 **agentId** 映射到链上身份（SBT / registry）。
- 验证历史：提供兼容 ERC-8004 的验证注册表能力：
  - 以 request URI/hash 发起验证请求，
  - 以 response URI/hash + tag + score 提交响应，
  - 查询按 agentId 聚合的摘要数据。
- 策略（Policy）：
  - 按 agent 与按 task 的 x402 花费预算上限，
  - x402 资源白名单/黑名单，
  - 按任务类型设置“结算前最小验证要求”。
- 激励（Incentives）：
  - juror 奖励分配，以及可选的额外奖励（Items+Actions 发放积分/NFT），
  - 在争议或欺诈验证时对 juror/agent 的 slashing（或锁仓/惩罚）规则。

**x402 集成（Web 支付）**

- 一个网关服务（Gateway）：
  - 代表 agent 购买资源（x402 client），
  - 作为代理支持赞助支付（community-funded x402），
  - 输出可审计的支付回执（可选 webproof/zk proof）。
- 至少支持一种稳定币授权支付轨道：
  - ERC-2612 Permit 和/或 EIP-3009 transfer authorization（取决于 token），
  - 能用则走 AA gasless 提交（Paymaster/Bundler 集成）。

### 4.3（中文版）非功能需求

- **可审计**：每次验证与每次付费资源访问都能归因到 agentId 与 taskId（直接或经由回执）。
- **安全**：预算限制、重放保护、签名时间窗。
- **隐私控制**：链上仅存 hash；完整证据与回执存链下（IPFS/HTTP）。
- **可扩展**：尽量无需升级合约即可接入新的资源类型与验证者。

### 4.4（中文版）MVP 成功指标

- 任务完成率与从提交到 validated 的中位耗时。
- 成本可预测性：每任务 x402 花费的预估 vs 实际偏差。
- 验证质量：验证分与争议之间的相关性。
- agent 可靠性：N 个任务内无争议的复用完成率。

## 5）技术设计（系统架构）

### 5.1（中文版）高层组件

**链上**

- `TaskEscrow`（MyTask）：托管任务资金、管理生命周期、结算分账。
- `JuryContract`（MyTask）：陪审质押/注册 + 陪审任务；作为一种“验证者实现”可通过适配层对齐 ERC-8004 Validation Registry 的接口语义。
- 身份/角色：MySBT + Registry/role 系统（依 `TotalSolution.md` 的跨仓库设计）。

**链下**

- **Agent Orchestrator（编排器）**：监听链上事件，驱动任务执行工作流，保存证据/回执，发起验证。
- **x402 Gateway（支付网关）**：
  - 资源代理（处理 402 challenge/response），
  - 赞助引擎（community 预算），
  - 回执存储（hash + 元数据）。
- **索引与存储**：
  - 最小索引器（events → DB），
  - IPFS（证据、验证报告、回执）或对象存储。

### 5.2（中文版）关键流程

#### 流程 A：任务生命周期 + 陪审验证（现有）

1）Community 创建任务（托管奖励）。  
2）Taskor 接单并提交证据。  
3）外部 agent（或 community）触发陪审流程，并将已完成的陪审任务链接到托管任务。  
4）Escrow 结算分账。  

#### 流程 B：Agent 为任务通过 x402 购买工具/数据（新增）

1）Agent 识别任务需要外部数据/算力/工具。  
2）Agent 请求一个受 x402 保护的资源端点。  
3）x402 Gateway 处理 `402 Payment Required`，并选择：
   - 使用 agent 预算支付，或
   - 走赞助路径：community 以行动/数据策略为交换进行支付。  
4）Gateway 存储回执（可选 ZK/webproof）并把资源返回给 agent。  
5）回执 hash 被附加到 task 的 evidence URI 或 validation request URI。  

#### 流程 C：以 ERC-8004 验证注册表作为“声誉底座”（新增）

1）Agent（或 orchestrator）发出验证请求，引用：
   - taskId、evidence URI、回执、评估量表/规则。  
2）验证者/陪审提交响应：
   - score（0-100）、tag（类别）、response URI/hash。  
3）按 agentId 聚合声誉查询（次数、均分、按 tag 维度）。  
4）MyTask 的结算策略可按任务类型引入 “最小验证达成” 门槛。  

### 5.3（中文版）数据模型（规范化标识）

- `taskId`（bytes32）：MyTask 的主任务标识。
- `agentId`（uint256）：验证与经济系统的主 Agent 标识。
- `requestHash`（bytes32）：验证请求标识（尽量可确定性生成）。
- `x402ReceiptId`（bytes32）：规范化支付回执负载的 hash。

### 5.4（中文版）经济模型（默认值，可配置）

**分账（Payouts）**

- Community 托管任务奖励资金。
- 结算时拆分为：
  - Taskor payout，
  - Supplier payout（可选、受上限约束），
  - Jury payout。  

**Agent 花费（Spend）**

- 每个任务可配置“工具/数据预算”。
- x402 支出从以下资金来源扣除：
  - task budget（community 出资），和/或
  - agent wallet（运营者出资），和/或
  - sponsor pool（community 出资且受策略约束）。  

**费用（Fees）**

- Facilitator / x402 gateway 收取费用：
  - 覆盖 gas/运营成本，
  - + 可配置的 margin。  

**声誉与惩罚（Reputation & Penalties）**

- 验证者/陪审通过被接受的验证积累声誉。
- 争议可能触发：
  - juror 质押罚没（slashing）或声誉惩罚，
  - 若证据欺诈成立，则 agent 声誉惩罚。  

## 6）路线图（里程碑）

### 里程碑 0：“链上生命周期演示”（已完成）

- 已有端到端 demo 脚本，可在 anvil 上跑通。
- TaskEscrow、JuryContract 与生命周期集成测试通过。

### 里程碑 1：“以 ERC-8004 为核心的 Agent 声誉”

- 将 validation registry 的使用标准化为核心声誉原语。
- 让任务结算支持“按 tag/阈值/数量”的可选验证门槛。

### 里程碑 2：“x402 支出 + 回执”

- 增加可支付并保存回执的 x402 网关。
- 将回执绑定到 task 与 validation request，使每次付费资源访问可审计。

### 里程碑 3：“Agent 经济策略”

- 预算、赞助池、策略引擎（允许的端点、花费上限、按任务约束）。
- 按 agentId 的花费与表现看板。

### 里程碑 4：“生产级加固”

- 安全审计、invariant 测试、事件响应预案。
- x402 代理与验证者侧的限流与反滥用机制。

## 7）工程任务拆分（Epic → Tasks）

### Epic A：验证标准化（ERC-8004 / EIP-8004）

- 定义 `requestUri` 与 `responseUri` 的规范 JSON schema。
- 增加任务策略：需要的 tags、最小数量、最小均分等。
- 增加验证事件索引与按 agent 聚合统计。
- 定义争议触发映射（验证冲突时，哪些可罚没、如何处理）。

### Epic B：x402 网关与回执

- 实现 x402 客户端模块（agent 侧）与代理模块（赞助侧）。
- 实现回执体系：
  - 规范化、
  - 哈希化、
  - 存储（IPFS/DB）、
  - 与任务证据的关联。  
- 实现赞助流程：
  - 匹配赞助规则（行动/数据）、
  - 预算记账与报表。  

### Epic C：Agent 运行时与编排

- 实现事件驱动 orchestrator：
  - 监听任务生命周期事件，
  - 驱动 agent 执行，
  - 发起验证，
  - 提交链上链接/结算。  
- 增加 “人工在环 / 手动覆盖” 检查点（用于高风险任务）。

### Epic D：身份与角色（MySBT / registry）

- 定义 agent 身份生命周期：
  - mint/分配 agentId，
  - 验证者/陪审的角色 gating，
  - 抗女巫选项。  
- 增加基于角色的权限：哪些角色可请求/响应哪些验证 tag。

### Epic E：UI + 可观测性

- 构建角色看板：
  - tasks、validations、disputes，
  - x402 花费与回执，
  - 按 agent 的声誉。  
- 为网关与编排器增加结构化日志与 trace。

## 8）开放问题（需尽早定案）

- `agentId` 的权威来源是什么（SBT tokenId / registry 映射 / 派生规则）？
- MVP 必选的支付授权轨道是什么：
  - ERC-2612、EIP-3009（依 token 而定）、还是仅 AA？
- 最小争议模型是什么：
  - “软争议”（只影响声誉）还是 “硬争议”（罚没 + 链上仲裁）？
- 回执存储在哪里、链上记录到什么粒度（仅 hash vs 完整 URI）？
