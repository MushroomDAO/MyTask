// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Script.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {MySBT} from "../src/MySBT.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "../test/mocks/ERC20Mock.sol";

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
        uint256 deployerPrivateKey =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        // Configuration
        address mySBT = vm.envOr("MYSBT_ADDRESS", address(0));
        address stakingToken = vm.envOr("STAKING_TOKEN", address(0x2));
        uint256 minJurorStake = vm.envOr("MIN_JUROR_STAKE", uint256(100 ether));
        address feeRecipient = vm.envOr("FEE_RECIPIENT", address(0x3));

        vm.startBroadcast(deployerPrivateKey);

        if (mySBT == address(0) || mySBT.code.length == 0) {
            MySBT sbt = new MySBT();
            mySBT = address(sbt);
            console.log("MySBT deployed at:", mySBT);
        }

        // Deploy JuryContract
        JuryContract jury = new JuryContract(mySBT, stakingToken, minJurorStake);
        jury.setRequireNonZeroValidationRequestHash(true);
        console.log("JuryContract deployed at:", address(jury));

        // Deploy TaskEscrow
        TaskEscrow escrow = new TaskEscrow(address(jury), feeRecipient);
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

contract DemoLifecycle is Script {
    uint256 internal constant COMMUNITY_PK = uint256(keccak256("MYTASK_COMMUNITY"));
    uint256 internal constant TASKOR_PK = uint256(keccak256("MYTASK_TASKOR"));
    uint256 internal constant SUPPLIER_PK = uint256(keccak256("MYTASK_SUPPLIER"));
    uint256 internal constant JUROR1_PK = uint256(keccak256("MYTASK_JUROR_1"));
    uint256 internal constant JUROR2_PK = uint256(keccak256("MYTASK_JUROR_2"));
    uint256 internal constant JUROR3_PK = uint256(keccak256("MYTASK_JUROR_3"));
    uint256 internal constant AGENT_PK = uint256(keccak256("MYTASK_AGENT"));

    ERC20Mock internal token;
    ERC20Mock internal stakingToken;
    JuryContract internal jury;
    TaskEscrow internal escrow;

    uint256 internal reward;
    uint256 internal minStake;
    uint256 internal supplierFee;

    address internal mySBT;
    address internal feeRecipient;

    bytes32 internal taskId;
    bytes32 internal juryTaskHash;

    function _syncToRpcHead() internal {
        string memory rpcUrl = vm.envOr("RPC_URL", string("http://127.0.0.1:8545"));
        bytes memory blockJsonBytes = vm.rpc(rpcUrl, "eth_getBlockByNumber", "[\"latest\", false]");
        string memory blockJson = string(blockJsonBytes);
        string memory tsStr = vm.parseJsonString(blockJson, ".timestamp");
        string memory heightStr = vm.parseJsonString(blockJson, ".number");
        uint256 ts = vm.parseUint(tsStr);
        uint256 height = vm.parseUint(heightStr);
        vm.warp(ts);
        vm.roll(height);
    }

    function _advance() internal {
        vm.warp(vm.getBlockTimestamp() + 1);
        vm.roll(vm.getBlockNumber() + 1);
    }

    function run() external {
        uint256 deployerPrivateKey =
            vm.envOr("PRIVATE_KEY", uint256(0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80));

        reward = vm.envOr("REWARD", uint256(1000 ether));
        minStake = vm.envOr("MIN_JUROR_STAKE", uint256(100 ether));
        supplierFee = vm.envOr("SUPPLIER_FEE", uint256(150 ether));

        mySBT = vm.envOr("MYSBT_ADDRESS", address(0));
        feeRecipient = vm.envOr("FEE_RECIPIENT", vm.addr(deployerPrivateKey));

        _deployAndFund(deployerPrivateKey);
        _registerJurors();
        _createAndSubmitTask();
        _createAndCompleteJuryTask();
        _erc8004ValidationDemo();
        _linkAndSettle();
    }

    function _deployAndFund(uint256 deployerPrivateKey) internal {
        address community = vm.addr(COMMUNITY_PK);
        address taskor = vm.addr(TASKOR_PK);
        address supplier = vm.addr(SUPPLIER_PK);
        address juror1 = vm.addr(JUROR1_PK);
        address juror2 = vm.addr(JUROR2_PK);
        address juror3 = vm.addr(JUROR3_PK);
        address agent = vm.addr(AGENT_PK);

        vm.startBroadcast(deployerPrivateKey);
        _advance();
        if (mySBT == address(0) || mySBT.code.length == 0) {
            MySBT sbt = new MySBT();
            mySBT = address(sbt);
        }
        _advance();
        MySBT(mySBT).mint(taskor, 1);
        _advance();
        token = new ERC20Mock("USDC", "USDC", 18);
        _advance();
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);
        _advance();
        jury = new JuryContract(mySBT, address(stakingToken), minStake);
        _advance();
        jury.setRequireNonZeroValidationRequestHash(true);
        _advance();
        jury.setRequireJurorRole(true);
        _advance();
        jury.setRequireValidationRequesterRole(true);
        _advance();
        jury.grantRole(jury.ROLE_JUROR(), juror1);
        _advance();
        jury.grantRole(jury.ROLE_JUROR(), juror2);
        _advance();
        jury.grantRole(jury.ROLE_JUROR(), juror3);
        _advance();
        jury.grantRole(jury.ROLE_VALIDATION_REQUESTER(), taskor);
        _advance();
        escrow = new TaskEscrow(address(jury), feeRecipient);

        _advance();
        token.mint(community, reward);
        _advance();
        stakingToken.mint(juror1, minStake);
        _advance();
        stakingToken.mint(juror2, minStake);
        _advance();
        stakingToken.mint(juror3, minStake);

        _advance();
        payable(community).transfer(1 ether);
        _advance();
        payable(taskor).transfer(1 ether);
        _advance();
        payable(supplier).transfer(1 ether);
        _advance();
        payable(juror1).transfer(1 ether);
        _advance();
        payable(juror2).transfer(1 ether);
        _advance();
        payable(juror3).transfer(1 ether);
        _advance();
        payable(agent).transfer(1 ether);

        vm.stopBroadcast();
    }

    function _registerJuror(uint256 jurorPrivateKey) internal {
        vm.startBroadcast(jurorPrivateKey);
        _advance();
        stakingToken.approve(address(jury), type(uint256).max);
        _advance();
        jury.registerJuror(minStake);
        vm.stopBroadcast();
    }

    function _registerJurors() internal {
        _registerJuror(JUROR1_PK);
        _registerJuror(JUROR2_PK);
        _registerJuror(JUROR3_PK);
    }

    function _createAndSubmitTask() internal {
        vm.startBroadcast(COMMUNITY_PK);
        _advance();
        token.approve(address(escrow), type(uint256).max);

        ITaskEscrow.CreateTaskParams memory params = ITaskEscrow.CreateTaskParams({
            token: address(token),
            reward: reward,
            deadline: type(uint256).max,
            minJurors: 3,
            metadataUri: "ipfs://task-metadata",
            taskType: bytes32("SIMPLE")
        });
        _advance();
        escrow.createTask(params);
        vm.stopBroadcast();

        bytes32[] memory tasks = escrow.getTasksByCommunity(vm.addr(COMMUNITY_PK));
        taskId = tasks[tasks.length - 1];

        vm.startBroadcast(TASKOR_PK);
        _advance();
        escrow.acceptTask(taskId);
        _advance();
        escrow.assignSupplier(taskId, vm.addr(SUPPLIER_PK), supplierFee);
        _advance();
        escrow.submitEvidence(taskId, "ipfs://evidence");
        vm.stopBroadcast();
    }

    function _createAndCompleteJuryTask() internal {
        vm.startBroadcast(AGENT_PK);
        IJuryContract.TaskParams memory juryParams = IJuryContract.TaskParams({
            agentId: 1,
            taskType: IJuryContract.TaskType.CONSENSUS_REQUIRED,
            evidenceUri: "ipfs://jury-evidence",
            reward: 0,
            deadline: type(uint256).max,
            minJurors: 3,
            consensusThreshold: 6600
        });
        _advance();
        juryTaskHash = jury.createTask(juryParams);
        _advance();
        jury.submitEvidence(juryTaskHash, "ipfs://jury-evidence");
        vm.stopBroadcast();

        vm.startBroadcast(JUROR1_PK);
        _advance();
        jury.vote(juryTaskHash, 80, "");
        vm.stopBroadcast();

        vm.startBroadcast(JUROR2_PK);
        _advance();
        jury.vote(juryTaskHash, 90, "");
        vm.stopBroadcast();

        vm.startBroadcast(JUROR3_PK);
        _advance();
        jury.vote(juryTaskHash, 85, "");
        vm.stopBroadcast();

        vm.startBroadcast(AGENT_PK);
        _advance();
        jury.finalizeTask(juryTaskHash);
        vm.stopBroadcast();
    }

    function _erc8004ValidationDemo() internal {
        bytes32 tag = bytes32("QUALITY");
        string memory requestUri = "ipfs://erc8004-validation-request";
        bytes32 requestHash = jury.deriveValidationRequestHash(taskId, 1, address(jury), tag, requestUri);

        vm.startBroadcast(TASKOR_PK);
        _advance();
        jury.validationRequest(address(jury), 1, requestUri, requestHash);
        vm.stopBroadcast();

        vm.startBroadcast(JUROR1_PK);
        _advance();
        jury.validationResponse(requestHash, 100, "ipfs://erc8004-validation-response", bytes32(0), tag);
        vm.stopBroadcast();

        (address validator, uint256 agentId, uint8 response, bytes32 statusTag,) = jury.getValidationStatus(requestHash);
        console.log("\n=== ERC-8004 Validation Demo ===");
        console.log("requestHash:");
        console.logBytes32(requestHash);
        console.log("validator:", validator);
        console.log("agentId:", agentId);
        console.log("response:", response);
        console.log("tag:");
        console.logBytes32(statusTag);
    }

    function _linkAndSettle() internal {
        address taskor = vm.addr(TASKOR_PK);
        address supplier = vm.addr(SUPPLIER_PK);

        vm.startBroadcast(AGENT_PK);
        _advance();
        escrow.linkJuryValidation(taskId, juryTaskHash);

        (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout) = escrow.calculatePayouts(taskId);
        uint256 taskorBefore = token.balanceOf(taskor);
        uint256 supplierBefore = token.balanceOf(supplier);
        uint256 juryBefore = token.balanceOf(address(jury));

        _advance();
        escrow.completeTask(taskId);

        console.log("\n=== DemoLifecycle Summary ===");
        console.log("Token:", address(token));
        console.log("StakingToken:", address(stakingToken));
        console.log("JuryContract:", address(jury));
        console.log("TaskEscrow:", address(escrow));
        console.log("Community:", vm.addr(COMMUNITY_PK));
        console.log("Taskor:", taskor);
        console.log("Supplier:", supplier);
        console.log("Agent:", vm.addr(AGENT_PK));
        console.log("taskId:");
        console.logBytes32(taskId);
        console.log("juryTaskHash:");
        console.logBytes32(juryTaskHash);
        console.log("taskorPayout:", taskorPayout);
        console.log("supplierPayout:", supplierPayout);
        console.log("juryPayout:", juryPayout);
        console.log("taskorPaid:", token.balanceOf(taskor) - taskorBefore);
        console.log("supplierPaid:", token.balanceOf(supplier) - supplierBefore);
        console.log("juryPaid:", token.balanceOf(address(jury)) - juryBefore);
        console.log("escrowBalance:", token.balanceOf(address(escrow)));
        vm.stopBroadcast();
    }
}
