# Sepolia (11155111) 部署记录说明

本目录下已入库的 run 记录(`run-1783707098717.json` / `run-latest.json`)是
**P0 修复之前**旧源码的真实部署历史,保留用于追溯当前线上合约:

| 合约 | 地址 |
|---|---|
| JuryContract | `0xa3e6d98b992bcf31be0d1af4670c675264005fa8` |
| TaskEscrowV2 | `0x421b4d66c82cef6432dfe340208487f27bae8011` |
| StakingToken (ERC20Mock xPNT) | `0x02a24816524e02149180bc4deecc1dc0d042ff75` |
| RewardToken (ERC20Mock USDC) | `0x959f87797f54b5fcf8fc9d8f7f7cf4f1881c8e36` |

注意与当前源码的差异:

- 该次部署的 `TaskEscrowV2` 是**两参 constructor**(无 `challengeStakeToken`),
  挑战质押仍为原生 ETH(MT-2 修复前);
- 部署流程**没有调用** `jury.setAuthorizedEscrow(escrow, true)`,
  JuryContract 也没有 `notifyReward` 奖励池(MT-1 修复前),
  即线上合约仍存在 jury 分成资金黑洞与 AA 挑战不可用问题。

因此**线上合约不含 P0 修复,不要在其上继续集成**。修复合并后需按 MT-8 用
更新后的 `script/DeploySepolia.s.sol` 重新部署,届时以新的 broadcast 记录为准。
