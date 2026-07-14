// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {MySBT} from "../src/MySBT.sol";
import {TaskEscrowV2} from "../src/TaskEscrowV2.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";

/**
 * MyTask → Sepolia deploy (Cos72 Phase 1). Env-driven (NEVER hardcodes a key,
 * unlike DeployLocal.s.sol which uses the anvil burn key). Deploy order is fixed
 * by TaskEscrowV2.juryContract being immutable: (SBT) -> stakingToken -> Jury -> Escrow.
 *
 * NOTE on broadcast records: the run records committed under
 * broadcast/DeploySepolia.s.sol/11155111/ were produced by the PRE-P0-fix source
 * (TaskEscrowV2 two-arg constructor, no jury.setAuthorizedEscrow). The contracts
 * currently live on Sepolia (escrow 0x421b4d66..., jury 0xa3e6d98b...) therefore
 * do NOT contain the MT-1/MT-2 fixes. Redeploy with this updated script (MT-8);
 * the new broadcast records will supersede the old ones. See the README in that
 * broadcast directory.
 *
 * Env (source SuperPaymaster/.env.sepolia):
 *   DEPLOYER_PRIVATE_KEY   required
 *   MYSBT_ADDRESS          optional — ecosystem SBT (recommended); else deploys a fresh MySBT
 *   FEE_RECIPIENT          optional — defaults to deployer
 *   MIN_JUROR_STAKE        optional — defaults to 0
 *   REWARD_TOKEN_ADDRESS   optional — if unset, deploys a mock USDC + mints to deployer
 */
contract DeploySepolia is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address existingSbt = vm.envOr("MYSBT_ADDRESS", address(0));
        address existingRewardToken = vm.envOr("REWARD_TOKEN_ADDRESS", address(0));
        uint256 minJurorStake = vm.envOr("MIN_JUROR_STAKE", uint256(0));

        vm.startBroadcast(deployerPk);

        // MyTask uses the ecosystem SBT (drop-custom-MySBT decision) — pass it via
        // MYSBT_ADDRESS. JuryContract only calls it in try/catch, so any address is safe.
        MySBT sbt = existingSbt == address(0) ? new MySBT() : MySBT(existingSbt);

        // Juror staking token — a mock ERC-20 (testnet). Jury requires non-zero.
        ERC20Mock stakingToken = new ERC20Mock("xPNT", "xPNT", 18);

        JuryContract jury = new JuryContract(address(sbt), address(stakingToken), minJurorStake);
        // Permissive/happy-path mode (like DeployLocal): no juror-role gating on testnet.
        jury.setRequireNonZeroValidationRequestHash(false);
        jury.setRequireJurorRole(false);
        jury.setRequireValidationRequesterRole(false);

        // Challenge stake is ERC-20 (xPNT), AA-compatible — no native ETH required
        TaskEscrowV2 escrow = new TaskEscrowV2(address(jury), feeRecipient, address(stakingToken));

        // Authorize escrow to register jury-share rewards (pull-pattern payouts)
        jury.setAuthorizedEscrow(address(escrow), true);

        ERC20Mock rewardToken;
        if (existingRewardToken == address(0)) {
            rewardToken = new ERC20Mock("USDC", "USDC", 6);
            rewardToken.mint(deployer, 10_000 * 1e6);
        }

        vm.stopBroadcast();

        console.log("=== MyTask Sepolia deploy ===");
        console.log("deployer:     ", deployer);
        console.log("MySBT (jury): ", address(sbt));
        console.log("JuryContract: ", address(jury));
        console.log("TaskEscrowV2: ", address(escrow));
        console.log("StakingToken: ", address(stakingToken));
        console.log("--- env lines (for cos72 aastar-frontend/.env.local) ---");
        console.log(string.concat("NEXT_PUBLIC_TASK_ESCROW_ADDRESS=", vm.toString(address(escrow))));
        console.log(string.concat("NEXT_PUBLIC_JURY_CONTRACT_ADDRESS=", vm.toString(address(jury))));
        console.log(string.concat("NEXT_PUBLIC_MYSBT_ADDRESS=", vm.toString(address(sbt))));
        if (existingRewardToken == address(0)) {
            console.log(
                string.concat("NEXT_PUBLIC_REWARD_TOKEN_ADDRESS=", vm.toString(address(rewardToken)))
            );
            console.log("NEXT_PUBLIC_REWARD_TOKEN_SYMBOL=USDC");
            console.log("NEXT_PUBLIC_REWARD_TOKEN_DECIMALS=6");
        }
    }
}
