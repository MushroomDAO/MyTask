# MyTask

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.23-blue.svg)](https://soliditylang.org/)
[![Foundry](https://img.shields.io/badge/Built%20with-Foundry-FFDB1C.svg)](https://getfoundry.sh/)
[![x402](https://img.shields.io/badge/Protocol-x402-purple.svg)](https://www.x402.org/)
[![ERC-8004](https://img.shields.io/badge/Standard-ERC--8004-green.svg)](https://eips.ethereum.org/EIPS/eip-8004)
[![AI Agents](https://img.shields.io/badge/AI-LangGraph-orange.svg)](https://langchain-ai.github.io/langgraph/)

AI-powered, permissionless task marketplace built on x402 protocol with four-party economic model.

## Architecture Overview

```mermaid
flowchart TB
    subgraph Users["👥 Four Roles"]
        S[("🏛️ Community<br/>Task Publisher")]
        T[("⚡ Taskor<br/>Task Executor")]
        P[("📦 Supplier<br/>Resource Provider")]
        J[("⚖️ Jury<br/>Validator")]
    end

    subgraph Agents["🤖 AI Agent Layer"]
        SA["Community Agent<br/>Budget Optimization"]
        TA["Taskor Agent<br/>Task Matching"]
        PA["Supplier Agent<br/>Pricing Strategy"]
        JA["Jury Agent<br/>Evidence Analysis"]
    end

    subgraph Chain["⛓️ On-Chain Layer"]
        ESC["Escrow Contract<br/>Fund Management"]
        JURY["Jury Contract<br/>Stake & Vote"]
        X402["x402 Middleware<br/>Payment Protocol"]
    end

    subgraph Flow["📋 Task Lifecycle"]
        F1["1. Create Task"]
        F2["2. Accept & Execute"]
        F3["3. Submit Evidence"]
        F4["4. Jury Validation"]
        F5["5. Settlement"]
    end

    S --> SA
    T --> TA
    P --> PA
    J --> JA

    SA <-->|"Negotiate"| TA
    TA <-->|"Request"| PA
    PA <-->|"Verify"| JA

    SA --> ESC
    TA --> X402
    PA --> X402
    JA --> JURY

    F1 --> F2 --> F3 --> F4 --> F5
    ESC -.->|"Lock Funds"| F1
    X402 -.->|"Gasless Pay"| F2
    JURY -.->|"Consensus"| F4
    ESC -.->|"Distribute"| F5
```

## Four-Party Economic Model

| Role | Responsibility | AI Agent Function | Incentive |
|------|----------------|-------------------|-----------|
| **Community** | Publish & fund tasks | Budget optimization, risk assessment | Task completion value |
| **Taskor** | Execute tasks | Task matching, execution planning | Task reward (70%) |
| **Supplier** | Provide resources | Dynamic pricing, inventory management | Resource fee (20%) |
| **Jury** | Validate completion | Evidence analysis, consensus voting | Validation fee (10%) |

## Core Features

- **AI-Driven Automation**: Each role has an autonomous AI agent (LangGraph-based)
- **x402 Protocol**: HTTP-native payment with gasless UX via EIP-2612/EIP-712
- **Permissionless**: No gatekeeping; anyone can participate in any role
- **Multi-Token Support**: Any ERC-20 following OpenPNTs protocol
- **On-Chain Settlement**: Transparent escrow with dispute resolution
- **Jury Consensus**: Stake-weighted voting for task validation

## Agent Interaction Flow

```mermaid
sequenceDiagram
    participant S as Community Agent
    participant T as Taskor Agent
    participant P as Supplier Agent
    participant J as Jury Agent
    participant C as Smart Contracts

    S->>C: createTask(params, reward)
    C-->>S: taskHash

    T->>T: analyzeTask(taskHash)
    T->>S: acceptTask(taskHash)

    T->>P: requestResource(resourceId)
    P->>P: optimizePrice()
    P-->>T: resourceProvided

    T->>C: submitEvidence(taskHash, proof)

    J->>J: analyzeEvidence(proof)
    J->>C: vote(taskHash, response)

    C->>C: checkConsensus()
    C->>S: refundExcess()
    C->>T: payTaskor(70%)
    C->>P: paySupplier(20%)
    C->>J: payJury(10%)
```

## Technology Stack

| Layer | Technology |
|-------|------------|
| Smart Contracts | Solidity (Foundry) |
| AI Agents | LangGraph + LLM (OpenAI/DeepSeek) |
| Payment Protocol | x402 + EIP-2612 (Gasless) |
| Identity | ERC-8004 Validation Registry |

## Project Structure

```
MyTask/
├── contracts/           # Foundry smart contracts
│   ├── src/
│   │   ├── JuryContract.sol
│   │   └── interfaces/
│   ├── test/
│   └── lib/forge-std/
├── docs/                # Architecture & analysis
└── submodules/          # Reference implementations
```

## Quick Start

```bash
# Install dependencies
cd contracts && forge install

# Run tests
forge test

# Deploy (local)
forge script script/Deploy.s.sol --rpc-url localhost:8545
```

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture Synthesis](docs/REFERENCE-ARCHITECTURE-SYNTHESIS.md) | Complete system design |
| [Integration Guide](docs/INTEGRATION-QUICK-START.md) | Quick start for developers |
| [ADRs](docs/ARCHITECTURE-DECISION-RECORDS.md) | Key design decisions |
| [PayBot Analysis](docs/PayBot-Core-Abstraction-Analysis.md) | Gasless payment deep-dive |
| [Hubble Integration](docs/HubbleAITrading-Integration-Solution.md) | Multi-agent architecture |

## Inspiration

Built upon research from:
- [Payload Exchange](https://github.com/microchipgnu/payload-exchange) - x402 payment proxy
- [Hubble AI Trading](https://github.com/HubbleVision/hubble-ai-trading) - Multi-agent system
- [PayBot](https://github.com/superposition/paybot) - Gasless middleware
- [Halo](https://github.com/humanlabs-kr/halo) - Decentralized infrastructure

## License

MIT License - Open source and permissionless.

---

# MyTask (中文版)

[![许可证: MIT](https://img.shields.io/badge/许可证-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Solidity](https://img.shields.io/badge/Solidity-0.8.23-blue.svg)](https://soliditylang.org/)
[![Foundry](https://img.shields.io/badge/构建工具-Foundry-FFDB1C.svg)](https://getfoundry.sh/)
[![x402](https://img.shields.io/badge/协议-x402-purple.svg)](https://www.x402.org/)
[![ERC-8004](https://img.shields.io/badge/标准-ERC--8004-green.svg)](https://eips.ethereum.org/EIPS/eip-8004)
[![AI Agents](https://img.shields.io/badge/AI-LangGraph-orange.svg)](https://langchain-ai.github.io/langgraph/)

基于 x402 协议的 AI 驱动、无许可任务市场，采用四方经济模型。

## 架构概览

```mermaid
flowchart TB
    subgraph Users["👥 四个角色"]
        S[("🏛️ 社区<br/>任务发布者")]
        T[("⚡ 执行者<br/>任务执行者")]
        P[("📦 供应商<br/>资源提供者")]
        J[("⚖️ 陪审团<br/>验证者")]
    end

    subgraph Agents["🤖 AI 代理层"]
        SA["社区代理<br/>预算优化"]
        TA["执行者代理<br/>任务匹配"]
        PA["供应商代理<br/>定价策略"]
        JA["陪审团代理<br/>证据分析"]
    end

    subgraph Chain["⛓️ 链上层"]
        ESC["托管合约<br/>资金管理"]
        JURY["陪审团合约<br/>质押与投票"]
        X402["x402 中间件<br/>支付协议"]
    end

    subgraph Flow["📋 任务生命周期"]
        F1["1. 创建任务"]
        F2["2. 接受并执行"]
        F3["3. 提交证据"]
        F4["4. 陪审团验证"]
        F5["5. 结算"]
    end

    S --> SA
    T --> TA
    P --> PA
    J --> JA

    SA <-->|"协商"| TA
    TA <-->|"请求"| PA
    PA <-->|"验证"| JA

    SA --> ESC
    TA --> X402
    PA --> X402
    JA --> JURY

    F1 --> F2 --> F3 --> F4 --> F5
    ESC -.->|"锁定资金"| F1
    X402 -.->|"无Gas支付"| F2
    JURY -.->|"共识"| F4
    ESC -.->|"分配"| F5
```

## 四方经济模型

| 角色 | 职责 | AI 代理功能 | 激励 |
|------|------|-------------|------|
| **社区 (Community)** | 发布并资助任务 | 预算优化、风险评估 | 任务完成价值 |
| **执行者 (Taskor)** | 执行任务 | 任务匹配、执行规划 | 任务奖励 (70%) |
| **供应商 (Supplier)** | 提供资源 | 动态定价、库存管理 | 资源费用 (20%) |
| **陪审团 (Jury)** | 验证完成情况 | 证据分析、共识投票 | 验证费用 (10%) |

## 核心特性

- **AI 驱动自动化**：每个角色都有自主 AI 代理（基于 LangGraph）
- **x402 协议**：HTTP 原生支付，通过 EIP-2612/EIP-712 实现无 Gas 体验
- **无许可**：无门槛，任何人都可以参与任何角色
- **多代币支持**：支持任何遵循 OpenPNTs 协议的 ERC-20 代币
- **链上结算**：透明托管与争议解决
- **陪审团共识**：基于质押权重的投票验证

## 代理交互流程

```mermaid
sequenceDiagram
    participant S as 社区代理
    participant T as 执行者代理
    participant P as 供应商代理
    participant J as 陪审团代理
    participant C as 智能合约

    S->>C: createTask(参数, 奖励)
    C-->>S: taskHash

    T->>T: analyzeTask(taskHash)
    T->>S: acceptTask(taskHash)

    T->>P: requestResource(resourceId)
    P->>P: optimizePrice()
    P-->>T: 资源已提供

    T->>C: submitEvidence(taskHash, 证明)

    J->>J: analyzeEvidence(证明)
    J->>C: vote(taskHash, 响应)

    C->>C: checkConsensus()
    C->>S: 退还多余资金
    C->>T: 支付执行者(70%)
    C->>P: 支付供应商(20%)
    C->>J: 支付陪审团(10%)
```

## 技术栈

| 层级 | 技术 |
|------|------|
| 智能合约 | Solidity (Foundry) |
| AI 代理 | LangGraph + LLM (OpenAI/DeepSeek) |
| 支付协议 | x402 + EIP-2612 (无Gas) |
| 身份验证 | ERC-8004 验证注册表 |

## 项目结构

```
MyTask/
├── contracts/           # Foundry 智能合约
│   ├── src/
│   │   ├── JuryContract.sol      # 陪审团合约
│   │   ├── TaskEscrow.sol        # 任务托管合约
│   │   └── interfaces/           # 接口定义
│   ├── test/                     # 测试文件
│   └── lib/forge-std/            # Foundry 标准库
├── docs/                         # 架构与分析文档
└── submodules/                   # 参考实现
```

## 快速开始

```bash
# 安装依赖
cd contracts && forge install

# 运行测试
forge test

# 部署（本地）
forge script script/Deploy.s.sol --rpc-url localhost:8545
```

## 文档

| 文档 | 描述 |
|------|------|
| [架构综合指南](docs/REFERENCE-ARCHITECTURE-SYNTHESIS.md) | 完整系统设计 |
| [集成快速指南](docs/INTEGRATION-QUICK-START.md) | 开发者快速入门 |
| [架构决策记录](docs/ARCHITECTURE-DECISION-RECORDS.md) | 关键设计决策 |
| [PayBot 分析](docs/PayBot-Core-Abstraction-Analysis.md) | 无 Gas 支付深度分析 |
| [Hubble 集成](docs/HubbleAITrading-Integration-Solution.md) | 多代理架构 |

## 灵感来源

基于以下项目的研究成果：
- [Payload Exchange](https://github.com/microchipgnu/payload-exchange) - x402 支付代理
- [Hubble AI Trading](https://github.com/HubbleVision/hubble-ai-trading) - 多代理系统
- [PayBot](https://github.com/superposition/paybot) - 无 Gas 中间件
- [Halo](https://github.com/humanlabs-kr/halo) - 去中心化基础设施

## 许可证

MIT 许可证 - 开源且无许可限制。
