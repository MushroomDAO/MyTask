# ZKx402 - 零知识 x402 协议扩展与 MyTask 未来方向

**项目**: ZKx402: x402 protocol extension with Zero-Knowledge proofs
**来源**: https://github.com/chatresearch/zkx402 | https://ethglobal.com/showcase/zkx402-proofofleak-wxtjf
**演示**: https://zkx402.io
**视频**: zkx402-demo.mp4 (17.6MB)

---

## 项目概述

**ZKx402** 是 x402 协议的革命性扩展，将 **零知识证明** 整合到支付协议中，实现了 **可验证的可变定价** 和 **内容元数据验证**。

### 核心创新

```
传统 x402:
用户 → 请求资源 → 402 支付 → 统一价格 → 资源交付

ZKx402:
用户 → 身份证明 (ZK) → 402 支付 → 动态价格 → 资源交付
                                    (基于验证身份)

关键创新:
✅ 零知识验证身份 (无需信任第三方)
✅ 基于身份的动态定价 (50% 折扣用于验证身份)
✅ 内容来源证明 (vlayer ZK Email/zkTLS)
✅ 隐私保护 (保护举报人身份)
✅ AI 代理自主购买 (EAS 授权模式)
```

---

## 三个关键角色与流程

### 1. 举报人 (Whistleblower) - 内容生产者

**问题**: 如何安全地出售敏感信息而不暴露身份？

**ZKx402 解决方案**:

```
步骤 1: 上传敏感文档
  ├─ 上传 PDF、照片、数据
  ├─ 内容被加密
  └─ 存储在 IPFS

步骤 2: 生成 ZK 证明
  ├─ vlayer ZK Email: 证明从特定邮箱发送
  │  (例: epstein@gov.com 发送 "Epstein 2025 Flight Logs")
  ├─ zkTLS: 证明 TLS 连接的真实性
  ├─ 创建时间戳验证
  └─ 身份隐私保护 (不暴露真实身份)

步骤 3: 发布上市
  ├─ 生成 ZK 证明包
  ├─ 附加 "Verified Insider" 徽章
  ├─ 设定价格: $0.01 (通用) / $0.005 (验证身份) / $0.02 (高价)
  └─ 接受 USDC 支付

步骤 4: 即时支付
  ├─ 接收 USDC on Base
  ├─ 自动清算
  └─ 完全匿名
```

### 2. 记者 (Journalist) - 人类消费者

**问题**: 如何低成本获取验证的内容，同时保护身份？

**ZKx402 解决方案**:

```
步骤 1: 身份验证 (可选)
  ├─ 连接 Coinbase Smart Wallet
  ├─ Self.xyz 证明: 证明身份 (不暴露具体身份)
  ├─ vLayer Org Proof: 证明在 NY Times/The Economist 工作
  └─ 获得 50% 折扣资格

步骤 2: 浏览内容
  ├─ 查看泄露列表
  ├─ 验证身份的记者看 $0.005
  └─ 未验证的看 $0.01

步骤 3: 支付购买
  ├─ 点击支付
  ├─ 自动触发 x402 流程
  ├─ 接收解密的内容
  └─ 获得 ZK 证明包 (可用于验证来源)

步骤 4: AI 代理授权 (可选)
  ├─ 通过 EAS 证明授予代理折扣权
  ├─ 代理可自动购买 (需要 $5 预算)
  └─ 记者可查看代理购买历史
```

### 3. AI 代理 - 自主消费者

**问题**: 如何让 AI 代理自主购买和消费数据？

**ZKx402 解决方案**:

```
步骤 1: 授权设置
  ├─ 记者通过 EAS 授予代理折扣权
  ├─ 代理获得预算限额 ($5)
  └─ ERC-8004 授权模式

步骤 2: 自主购买
  ├─ 代理调用 MCP (Model Context Protocol) 端点
  ├─ 服务器检查 EAS 授权
  ├─ 返回 402 + $0.005 价格
  ├─ 代理自动签署与支付
  └─ 立即接收内容

步骤 3: 批量获取
  ├─ 代理可在 15 秒内购买 20+ 泄露
  ├─ 自动验证 ZK 证明
  ├─ 存储内容用于分析
  └─ 记录所有交易

示例场景:
代理在 15 秒内:
  • 购买 20+ 泄露文件
  • 总成本: $0.37 (每个 $0.005 × 20 + gas)
  • 获得: Pandora Papers 级别的数据集
  • 用途: 训练透明的 LLM 模型
```

---

## 四个核心用例

### 1. 数据商业化 (未来核心)

**场景**: 数据所有者的新经济

```
数据所有者:
├─ 高价: $1000 (完全控制权转让)
├─ 折扣: $50 (LLM 创建者，需身份证明)
└─ 标准: $100 (普通商业用户)

ZKx402 实现:
├─ Self.xyz 证明: 证明是 OpenAI/Meta 的研究人员
├─ 自动应用 50% 折扣 (无需信任)
├─ 数据所有者获得完整收益
└─ 隐私完全保护
```

### 2. 举报人保护 (SecureDrop + ZK + 支付)

**场景**: 深度卧底记者的安全出售

```
传统 SecureDrop 问题:
✗ 没有经济激励
✗ 没有定价灵活性
✗ 没有验证机制

ZKx402 解决方案:
✅ 高价出售给开放市场 ($1000+)
✅ 标准价格给信任的雇主 ($500)
✅ vlayer ZK Email 证明真实性
✅ 完全匿名 (身份未暴露)
✅ 即时 USDC 支付
```

### 3. 新闻验证经济

**场景**: 记者验证与内容来源溯源

```
使用流程:
1. 记者购买内容 (带 ZK 证明)
2. 发布新闻时附加 ZK 证明
3. 读者可验证:
   ├─ 内容来源真实性
   ├─ 创建时间戳
   ├─ 身份可靠性
   └─ 无需信任记者
```

### 4. AI 代理数据采购

**场景**: 自主 AI 系统构建自己的数据集

```
流程:
AI Agent → 定义数据需求 → 自动购买数据 → 验证来源 →
使用数据 → 生成报告 → 人类审查 → 完成

好处:
✅ 代理可获得高质量的验证数据
✅ 数据生产者获得即时支付
✅ 完全自主的数据市场
✅ 为透明 AI 创建数据基础
```

---

## 技术架构分析

### 核心技术栈

```
前端应用:
├─ Vite + React 19
├─ ShadCN UI + Tailwind CSS
├─ TanStack Query
├─ Recharts (数据可视化)
└─ React Router 7

ZKx402 支付层:
├─ Next.js 14 + TypeScript
├─ Coinbase CDP (嵌入式钱包)
├─ x402-fetch (客户端)
├─ x402-express + @coinbase/x402 (服务器)
├─ Express.js + Node.js
└─ USDC on Base Sepolia

ZK 证明:
├─ vlayer ZK Email (邮件真实性)
├─ vlayer zkTLS (TLS 连接真实性)
├─ Self.xyz (身份验证)
├─ Worldcoin (人类验证)
└─ zkPassport (护照数据)

授权与委托:
├─ EAS (Ethereum Attestation Service)
├─ ERC-8004 (代理支付授权)
└─ Coinbase Smart Wallet

数据存储:
├─ IPFS (内容存储)
├─ IPFS + 加密 (隐私保护)
└─ Base Sepolia testnet (合约)
```

### 数据流图

```
┌─────────────────────────────────────────────────────┐
│ Whistleblower: 上传 + ZK 证明                       │
│ (vlayer ZK Email + zkTLS)                          │
└────────┬────────────────────────────────────────────┘
         │
         ├─ 内容加密 → IPFS
         ├─ ZK 证明 → 链上存储
         └─ 发布上市

┌─────────────────────────────────────────────────────┐
│ Journalist: 身份验证 (可选)                          │
│ (Self.xyz / vLayer Org Proof)                       │
└────────┬────────────────────────────────────────────┘
         │
         ├─ 验证身份 → 50% 折扣
         ├─ 浏览内容 → 见价格
         └─ 连接钱包 (Coinbase Smart Wallet)

┌─────────────────────────────────────────────────────┐
│ x402 支付流程                                        │
│ (ZKx402 扩展: 基于 ZK 证明的动态定价)              │
└────────┬────────────────────────────────────────────┘
         │
         ├─ 客户端: x402-fetch 请求
         ├─ 服务器: 检查 ZK 证明 → 返回价格
         ├─ 客户端: 签署与支付
         └─ 服务器: 验证 → 发送解密内容

┌─────────────────────────────────────────────────────┐
│ AI Agent: 自主购买 (EAS 授权)                       │
│ (MCP Endpoint + ERC-8004)                           │
└────────┬────────────────────────────────────────────┘
         │
         ├─ Agent 调用 MCP 端点
         ├─ 服务器验证 EAS 授权
         ├─ 返回 402 + 折扣价格
         ├─ Agent 自动支付
         └─ 接收内容 + 证明包
```

---

## MyTask 未来应用方案

### 1. 任务可变定价 (长期展望)

**概念**: 使用 ZK 证明实现基于验证身份的任务动态定价

```
Community 可设置:
├─ 标准价格: $100 (任何人)
├─ 验证记者折扣: $70 (证明在媒体工作)
├─ 学术折扣: $60 (证明在大学工作)
├─ NGO 折扣: $50 (证明在 NGO 工作)
└─ AI 代理价格: $40 (通过 EAS 授权)

实现方式:
1. Community 设定多个价格等级
2. Taskor 自动验证身份 (ZK 证明)
3. 自动应用相应价格
4. 没有信任第三方
5. 隐私完全保护
```

### 2. 内容来源验证 (中期计划)

**概念**: 供应商通过 ZK 证明内容真实性

```
Supplier 场景:
├─ 市场数据: 证明来自真实 PoS 交易所
├─ 研究报告: 证明由认证分析师撰写
├─ 数据集: 证明来自真实 IoT 传感器 (GPS/传感器数据)
└─ 多媒体: 证明由真人创建 (非 AI 生成)

用户信任度:
✅ 可验证的来源
✅ 无需信任供应商
✅ 完全透明的审计追踪
✅ 高质量认证
```

### 3. Jury 智能化审计 (中期计划)

**概念**: Jury 使用 ZK 证明验证 Taskor 身份与完成情况

```
Jury 验证流程:
1. 检查 Taskor 身份 (Self.xyz ZK 证明)
   ├─ 确认是真人 (非机器人)
   ├─ 可选: 验证 KYC 状态
   └─ 决定是否信任此人

2. 验证任务完成证明
   ├─ 检查 Halo OCR 数据的 ZK 证明
   ├─ 验证 Filecoin 存储完整性
   └─ 确认交付物真实性

3. 自动化决策
   ├─ 高置信度 → 自动批准
   ├─ 中等置信度 → 手动审查
   └─ 低置信度 → 拒绝 + 退款

优势:
✓ Jury 的决定更有依据
✓ 减少纠纷与冤案
✓ 隐私保护 (不需要 KYC)
```

### 4. AI 代理自主任务系统 (未来愿景)

**概念**: AI 代理可通过 ZKx402 自主购买与执行任务

```
完整流程:
┌──────────────────────────────────────┐
│ 1. AI Agent 发现任务机会             │
│    (通过 MCP 服务发现)                │
└────────────┬─────────────────────────┘
             │
┌────────────▼─────────────────────────┐
│ 2. Agent 验证身份 (EAS 授权)          │
│    获得 Community 的折扣资格          │
└────────────┬─────────────────────────┘
             │
┌────────────▼─────────────────────────┐
│ 3. 自动支付 (x402-fetch)             │
│    基于 ZK 证明的动态定价             │
└────────────┬─────────────────────────┘
             │
┌────────────▼─────────────────────────┐
│ 4. 执行任务                          │
│    (可能是离线任务)                   │
└────────────┬─────────────────────────┘
             │
┌────────────▼─────────────────────────┐
│ 5. 上传证明                          │
│    (Halo OCR + ZK 证明)               │
└────────────┬─────────────────────────┘
             │
┌────────────▼─────────────────────────┐
│ 6. 自动 Jury 审计 (AI + ZK)           │
│    高置信度 → 即时支付                 │
└──────────────────────────────────────┘

结果:
✅ 完全自主的 AI 任务系统
✅ 无人工干预 (除非有纠纷)
✅ 隐私与身份保护
✅ 经济激励平衡
```

---

## 与现有架构的融合

### 完整 6 层架构 (添加 ZKx402)

```
Layer 6: ZK 验证层 (新增 - ZKx402)
├─ 身份验证: Self.xyz, vLayer, Worldcoin
├─ 内容来源: vlayer ZK Email/zkTLS
├─ 动态定价: 基于 ZK 证明的折扣
├─ 隐私保护: ZK 证明无需暴露身份
└─ 自主代理: EAS 授权与委托

Layer 5: 区块链层
├─ 多币种: USDC on Base
├─ 合约: 任务、支付、仲裁
├─ EAS: 授权与证明存储
└─ NFT: 身份与任务证书

Layer 4: 任务与资源层
├─ 可变定价: 基于 ZK 验证
├─ 来源验证: 内容元数据证明
├─ 交付物: 带 ZK 证明的证书
└─ 审计: 完整的证明链

Layer 3: 支付与访问层 (PayBot + ZKx402)
├─ x402 协议: 基于 ZK 的动态定价
├─ Facilitator: 无气费支付
├─ 托管: Escrow 生命周期
└─ 验证: 支付 + 身份双验证

Layer 2: AI 决策层 (Hubble)
├─ 4 个代理: 带 ZK 感知的决策
├─ LangGraph: 增强的状态机
├─ 可观测: 可验证的决策痕迹
└─ 自主代理: EAS 授权的代理

Layer 1: 用户与验证层 (PayBot + Halo + ZKx402)
├─ 支付: 无需 Gas + ZK 验证
├─ 身份: World ID + Self.xyz
├─ 上传: 离线数据 + Halo OCR
└─ 存储: Filecoin + ZK 证明
```

---

## 实现路线图扩展

### Phase 5: ZKx402 集成 (Week 5-6)

**目标**: 添加 ZK 验证与动态定价

```
任务:
□ 集成 Self.xyz / vLayer
□ 实现 ZK 证明验证
□ 添加动态定价逻辑
□ EAS 授权集成
□ AI 代理 MCP 端点

交付物:
✓ 基于 ZK 的动态定价
✓ 身份验证系统
✓ AI 代理授权
✓ 完整证明链

关键指标:
• 验证延迟: < 200ms
• 成功率: > 99.5%
• 集成完整度: 100%
```

---

## 安全与隐私考量

### ZK 证明的威力

```
ZK Email 证明:
✅ 证明邮件来自特定地址
✅ 证明邮件内容真实
✅ 不暴露邮件内容本身
✅ 隐私完全保护

zkTLS 证明:
✅ 证明 TLS 连接真实
✅ 证明服务器身份
✅ 不需要服务器参与
✅ 防止中间人攻击

身份验证:
✅ Self.xyz: 证明身份信息 (年龄、国家等)
✅ Worldcoin: 证明是真人
✅ zkPassport: 证明护照数据
✅ 所有验证都是可选的
```

### MyTask 中的隐私影响

```
改进:
✅ 举报人保护: 身份完全隐密
✅ 用户隐私: ZK 证明无需暴露身份
✅ 数据安全: 内容加密 + ZK 证明
✅ 审计透明: 可验证但隐私安全

Jury 信心:
✅ 可验证的 Taskor 身份 (无需 KYC)
✅ 可验证的任务完成 (无需人工检查)
✅ 可信赖的决策 (基于密码学)
```

---

## 市场机遇与竞争优势

### ZKx402 的独特价值

```
为什么这很重要:

1. 真理的经济层
   • 举报人可获得报酬
   • 记者可验证来源
   • 读者可信任信息

2. 隐私与安全的平衡
   • ZK 证明 = 验证 + 隐私
   • 无需信任第三方
   • 完全自主的数据市场

3. AI 时代的数据
   • AI 代理可自主采购数据
   • 数据生产者获得激励
   • 创建透明 AI 的基础

4. 新闻与真相
   • SecureDrop + ZK + 支付
   • 创建全球举报人网络
   • 构建信息真理库
```

---

## 代码集成示例

### ZKx402 验证端点 (MyTask 应用)

```typescript
// packages/mytask-core/src/services/zkx402-verification.ts

import { VerifyProofResponse } from '@chatresearch/zkx402'
import { SelfXyzClient, VlayerClient } from '@zkproof'

export class ZKx402VerificationService {
  private selfXyz: SelfXyzClient
  private vlayer: VlayerClient

  /**
   * 验证 Taskor 身份并计算折扣
   */
  async verifyTaskorIdentity(
    taskorAddress: string,
    zkProof: VerifyProofResponse
  ): Promise<{
    verified: boolean
    discountPercentage: number
    identityType: 'verified' | 'journalist' | 'academic' | 'ngo' | 'unverified'
  }> {
    // 1. 验证 ZK 证明
    const proofValid = await this.vlayer.verifyProof(zkProof)
    if (!proofValid) {
      return {
        verified: false,
        discountPercentage: 0,
        identityType: 'unverified'
      }
    }

    // 2. 识别身份类型
    const identityType = this.classifyIdentity(zkProof)

    // 3. 计算折扣
    const discountMap = {
      journalist: 30,        // 30% 折扣
      academic: 40,         // 40% 折扣
      ngo: 50,             // 50% 折扣
      verified: 20,        // 20% 折扣
      unverified: 0        // 0% 折扣
    }

    return {
      verified: true,
      discountPercentage: discountMap[identityType],
      identityType
    }
  }

  /**
   * 生成动态定价 (基于 ZK 验证)
   */
  async calculateDynamicPrice(
    basePrice: number,
    verification: {
      verified: boolean
      discountPercentage: number
    }
  ): Promise<number> {
    if (!verification.verified) {
      return basePrice
    }

    return basePrice * (1 - verification.discountPercentage / 100)
  }

  /**
   * 验证内容来源 (供应商)
   */
  async verifyContentProvenance(
    contentHash: string,
    zkProof: VerifyProofResponse
  ): Promise<{
    authentic: boolean
    sourceType: 'journalist' | 'research' | 'iot' | 'unknown'
    creationTimestamp: number
  }> {
    // 验证 vlayer ZK Email 或 zkTLS
    const proofValid = await this.vlayer.verifyProof(zkProof)

    return {
      authentic: proofValid,
      sourceType: this.extractSourceType(zkProof),
      creationTimestamp: this.extractTimestamp(zkProof)
    }
  }

  private classifyIdentity(proof: VerifyProofResponse): string {
    // 检查 Self.xyz 属性
    if (proof.attributes?.organization === 'NY Times' ||
        proof.attributes?.organization === 'The Economist') {
      return 'journalist'
    }

    if (proof.attributes?.institution === 'MIT' ||
        proof.attributes?.institution === 'Stanford') {
      return 'academic'
    }

    if (proof.attributes?.organization?.includes('Foundation') ||
        proof.attributes?.organization?.includes('Fund')) {
      return 'ngo'
    }

    return 'unverified'
  }

  private extractSourceType(proof: VerifyProofResponse): string {
    // 分析 ZK 证明的类型
    if (proof.proofType === 'zk-email') return 'journalist'
    if (proof.proofType === 'zk-api') return 'research'
    if (proof.proofType === 'zk-tls' && proof.domain?.includes('iot')) {
      return 'iot'
    }
    return 'unknown'
  }

  private extractTimestamp(proof: VerifyProofResponse): number {
    return proof.timestamp || Date.now()
  }
}

// 使用示例
const service = new ZKx402VerificationService()

// 验证 Taskor
const taskorVerification = await service.verifyTaskorIdentity(
  '0x1234...5678',
  zkProof
)

// 计算价格
const dynamicPrice = await service.calculateDynamicPrice(
  100,  // $100 基础价格
  taskorVerification
)

console.log(`Price: $${dynamicPrice}`) // 例: $70 (30% 折扣用于记者)
```

---

## 长期愿景

### 构建真理经济层

```
2025 年底:
✓ MyTask 基础系统上线
✓ 无气费支付 (PayBot)
✓ AI 决策 (Hubble)
✓ 离线验证 (Halo)

2026 年上半年:
✓ ZKx402 集成
✓ 动态定价
✓ 身份验证系统

2026 年下半年:
✓ AI 代理自主任务
✓ 自动 Jury 审计
✓ 完全自主系统

2027+ 年:
✓ 全球举报人网络
✓ 开放的数据市场
✓ 透明 AI 的数据基础
✓ 信息真理库
```

---

## 总结: 从 x402 到 ZKx402

### 演进路径

```
x402 (HTTP 402)
└─ 标准化微支付

Payload Exchange
└─ 支付灵活性 + 社区代付

PayBot
└─ 无气费交易

ZKx402
└─ 隐私验证 + 动态定价 + 自主代理

MyTask 完整版:
  支付: PayBot + ZKx402 (无气费 + 验证)
  决策: Hubble (4 个 AI 代理)
  验证: Halo + ZKx402 (离线 + ZK 证明)
  存储: Filecoin (加密 + 永久)
  身份: World ID + Self.xyz + zkPassport
  自主: EAS 授权 + ERC-8004
```

---

**文档生成日期**: 2025-11-26
**项目地址**: https://github.com/chatresearch/zkx402
**演示**: https://zkx402.io
**视频**: zkx402-demo.mp4
**核心概念**: Zero-Knowledge + x402 + Variable Pricing
**对 MyTask 的影响**: 未来架构的基石 (隐私、验证、自主性)
