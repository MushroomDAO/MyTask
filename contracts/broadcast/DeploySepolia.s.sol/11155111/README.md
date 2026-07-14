# Sepolia broadcast records

**Current deployment (MT-8, 2026-07-14, post-P0-fix bytecode)** — `run-latest.json`:

| Contract | Address |
|---|---|
| TaskEscrowV2 (3-arg ctor, ERC-20 challenge stake) | `0x171234DD282eF2909ec20dafC3F81deBa6761178` |
| JuryContract (pull-claim rewards, setAuthorizedEscrow ✓) | `0x63f38d996d5D2784Da135f1B8B164c97a71e0161` |
| MySBT | ecosystem canonical `0x4867B4302bf4C7818b71F55E53A3520Ee1855Aa7` (NOT deployed by this script — MT-4) |
| StakingToken (mock xPNT, 18d) | `0xDbdaa6793e4F1b856baA7F8fd84F2E6aEE69ab09` |
| RewardToken (mock USDC, 6d) | `0x96C74b26ee4b7b57d576cf97b773906Cc7EE4E5B` |

All verified on Etherscan. On-chain checks: `jury.authorizedEscrows(escrow) == true`, `escrow.challengeStakeToken() == xPNT`.

**Historical (pre-P0-fix)** — earlier run files record the ORIGINAL deployment
(TaskEscrowV2 two-arg constructor, no `setAuthorizedEscrow`; escrow `0x421b4d66…`,
jury `0xa3e6d98b…`). Those contracts remain on Sepolia but are SUPERSEDED — do not
point new clients at them (jury share black-hole + native-ETH challenge stake).
