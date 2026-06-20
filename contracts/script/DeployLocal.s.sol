// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {MySBT} from "../src/MySBT.sol";
import {TaskEscrowV2} from "../src/TaskEscrowV2.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";

/**
 * @title DeployLocal
 * @notice Local anvil deployment for E2E testing.
 *
 * Usage:
 *   anvil &
 *   forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
 *
 * Deploys:
 *   - MySBT
 *   - JuryContract (permissive, for happy-path testing)
 *   - TaskEscrowV2
 *   - ERC20Mock (reward token "USDC")
 *
 * Mints 10,000 USDC to:
 *   - anvil account[0]: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  (Community / task publisher)
 *   - anvil account[1]: 0x70997970C51812dc3A010C7d01b50e0d17dc79C8  (Taskor / task executor)
 */
contract DeployLocal is Script {
    // Default anvil accounts
    address internal constant ACCOUNT_0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    address internal constant ACCOUNT_1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
    uint256 internal constant DEPLOYER_PK =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function run() external {
        vm.startBroadcast(DEPLOYER_PK);

        // 1. MySBT
        MySBT sbt = new MySBT();

        // 2. Staking token (for JuryContract – not used in happy path)
        ERC20Mock stakingToken = new ERC20Mock("xPNT", "xPNT", 18);

        // 3. JuryContract – permissive: no role requirements for local testing
        JuryContract jury = new JuryContract(address(sbt), address(stakingToken), 0);
        jury.setRequireNonZeroValidationRequestHash(false);
        jury.setRequireJurorRole(false);
        jury.setRequireValidationRequesterRole(false);

        // 4. TaskEscrowV2
        TaskEscrowV2 escrow = new TaskEscrowV2(address(jury), ACCOUNT_0);

        // 5. Reward token
        ERC20Mock usdc = new ERC20Mock("USDC", "USDC", 6);
        usdc.mint(ACCOUNT_0, 10_000 * 1e6);
        usdc.mint(ACCOUNT_1, 10_000 * 1e6);

        vm.stopBroadcast();

        // ====== Output ======
        console.log("\n=== DeployLocal Summary ===");
        console.log("MySBT:          ", address(sbt));
        console.log("JuryContract:   ", address(jury));
        console.log("TaskEscrowV2:   ", address(escrow));
        console.log("USDC (reward):  ", address(usdc));
        console.log("StakingToken:   ", address(stakingToken));
        console.log("");
        console.log("Account[0] (Community): ", ACCOUNT_0);
        console.log("Account[1] (Taskor):    ", ACCOUNT_1);
        console.log("");
        console.log("=== .env.local config ===");
        console.log("NEXT_PUBLIC_CHAIN_ID=31337");
        console.log("NEXT_PUBLIC_RPC_URL=http://127.0.0.1:8545");
        console.log(string.concat("NEXT_PUBLIC_TASK_ESCROW_ADDRESS=", vm.toString(address(escrow))));
        console.log(string.concat("NEXT_PUBLIC_JURY_CONTRACT_ADDRESS=", vm.toString(address(jury))));
        console.log(string.concat("NEXT_PUBLIC_MYSBT_ADDRESS=", vm.toString(address(sbt))));
        console.log(string.concat("NEXT_PUBLIC_REWARD_TOKEN_ADDRESS=", vm.toString(address(usdc))));
        console.log("NEXT_PUBLIC_REWARD_TOKEN_SYMBOL=USDC");
        console.log("NEXT_PUBLIC_REWARD_TOKEN_DECIMALS=6");
    }
}
