// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";

/**
 * @title Deploy
 * @notice Deployment script for MyTask contracts
 *
 * Usage:
 *   # Local deployment
 *   forge script script/Deploy.s.sol --rpc-url localhost:8545 --broadcast
 *
 *   # Testnet deployment (e.g., Sepolia)
 *   forge script script/Deploy.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --verify
 */
contract Deploy is Script {
    function run() external {
        // Load deployer private key
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        // Configuration
        address mySBT = vm.envOr("MYSBT_ADDRESS", address(0x1));
        address stakingToken = vm.envOr("STAKING_TOKEN", address(0x2));
        uint256 minJurorStake = vm.envOr("MIN_JUROR_STAKE", uint256(100 ether));
        address feeRecipient = vm.envOr("FEE_RECIPIENT", address(0x3));

        vm.startBroadcast(deployerPrivateKey);

        // Deploy JuryContract
        JuryContract jury = new JuryContract(
            mySBT,
            stakingToken,
            minJurorStake
        );
        console.log("JuryContract deployed at:", address(jury));

        // Deploy TaskEscrow
        TaskEscrow escrow = new TaskEscrow(
            address(jury),
            feeRecipient
        );
        console.log("TaskEscrow deployed at:", address(escrow));

        vm.stopBroadcast();

        // Log deployment summary
        console.log("\n=== Deployment Summary ===");
        console.log("JuryContract:", address(jury));
        console.log("TaskEscrow:", address(escrow));
        console.log("MySBT:", mySBT);
        console.log("Staking Token:", stakingToken);
        console.log("Min Juror Stake:", minJurorStake);
        console.log("Fee Recipient:", feeRecipient);
    }
}
