// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, console} from "forge-std/Test.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract JuryContractTest is Test {
    JuryContract public jury;
    ERC20Mock public stakingToken;

    address public mySBT = address(0x1234);
    address public juror1 = address(0x1001);
    address public juror2 = address(0x1002);
    address public juror3 = address(0x1003);
    address public taskCreator = address(0x2001);

    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant AGENT_ID = 1;

    function setUp() public {
        // Deploy mock staking token
        stakingToken = new ERC20Mock("Test Token", "TEST", 18);

        // Deploy JuryContract
        jury = new JuryContract(mySBT, address(stakingToken), MIN_STAKE);

        // Mint tokens to jurors
        stakingToken.mint(juror1, 1000 ether);
        stakingToken.mint(juror2, 1000 ether);
        stakingToken.mint(juror3, 1000 ether);

        // Approve staking
        vm.prank(juror1);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror2);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror3);
        stakingToken.approve(address(jury), type(uint256).max);
    }

    function test_JurorRegistration() public {
        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);

        (bool isActive, uint256 stake) = jury.isActiveJuror(juror1);
        assertTrue(isActive);
        assertEq(stake, MIN_STAKE);
    }

    function test_JurorRegistrationFailsWithLowStake() public {
        vm.prank(juror1);
        vm.expectRevert("Stake too low");
        jury.registerJuror(MIN_STAKE - 1);
    }

    function test_CreateTask() public {
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.CONSENSUS_REQUIRED,
            evidenceUri: "ipfs://QmEvidence",
            reward: 1 ether,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            consensusThreshold: 6600
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);

        IJuryContract.Task memory task = jury.getTask(taskHash);
        assertEq(task.agentId, AGENT_ID);
        assertEq(uint8(task.taskType), uint8(IJuryContract.TaskType.CONSENSUS_REQUIRED));
        assertEq(uint8(task.status), uint8(IJuryContract.TaskStatus.PENDING));
    }

    function test_SubmitEvidence() public {
        // Create task
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "",
            reward: 1 ether,
            deadline: block.timestamp + 7 days,
            minJurors: 1,
            consensusThreshold: 5000
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);

        // Submit evidence
        vm.prank(taskCreator);
        jury.submitEvidence(taskHash, "ipfs://QmNewEvidence");

        IJuryContract.Task memory task = jury.getTask(taskHash);
        assertEq(task.evidenceUri, "ipfs://QmNewEvidence");
        assertEq(uint8(task.status), uint8(IJuryContract.TaskStatus.IN_PROGRESS));
    }

    function test_JurorVoting() public {
        // Register juror
        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);

        // Create task
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "ipfs://QmEvidence",
            reward: 1 ether,
            deadline: block.timestamp + 7 days,
            minJurors: 1,
            consensusThreshold: 5000
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);

        // Submit evidence to start task
        vm.prank(taskCreator);
        jury.submitEvidence(taskHash, "ipfs://QmEvidence");

        // Vote
        vm.prank(juror1);
        jury.vote(taskHash, 85, "ipfs://QmReasoning");

        (IJuryContract.Vote memory vote, bool hasVoted) = jury.getJurorVote(taskHash, juror1);
        assertTrue(hasVoted);
        assertEq(vote.response, 85);
        assertEq(vote.juror, juror1);
    }

    function test_TaskFinalization() public {
        // Register jurors
        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror2);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror3);
        jury.registerJuror(MIN_STAKE);

        // Create task
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.CONSENSUS_REQUIRED,
            evidenceUri: "ipfs://QmEvidence",
            reward: 1 ether,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            consensusThreshold: 6600
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);

        // Submit evidence
        vm.prank(taskCreator);
        jury.submitEvidence(taskHash, "ipfs://QmEvidence");

        // All jurors vote positive
        vm.prank(juror1);
        jury.vote(taskHash, 80, "");
        vm.prank(juror2);
        jury.vote(taskHash, 90, "");
        vm.prank(juror3);
        jury.vote(taskHash, 85, "");

        // Finalize
        jury.finalizeTask(taskHash);

        IJuryContract.Task memory task = jury.getTask(taskHash);
        assertEq(uint8(task.status), uint8(IJuryContract.TaskStatus.COMPLETED));
        assertEq(task.finalResponse, 85); // Average of 80, 90, 85
    }

    function test_ERC8004ValidationStatus() public {
        // Register juror
        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);

        // Create and complete task
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "ipfs://QmEvidence",
            reward: 0,
            deadline: block.timestamp + 1 days,
            minJurors: 1,
            consensusThreshold: 5000
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);

        vm.prank(taskCreator);
        jury.submitEvidence(taskHash, "ipfs://QmEvidence");

        vm.prank(juror1);
        jury.vote(taskHash, 100, "");

        jury.finalizeTask(taskHash);

        // Check ERC-8004 validation status
        (address validator, uint256 agentId, uint8 response,,) = jury.getValidationStatus(taskHash);
        assertEq(validator, address(jury));
        assertEq(agentId, AGENT_ID);
        assertEq(response, 100);
    }

    function test_GetAgentValidations() public {
        // Create multiple tasks for same agent
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "ipfs://QmEvidence",
            reward: 0,
            deadline: block.timestamp + 1 days,
            minJurors: 1,
            consensusThreshold: 5000
        });

        vm.startPrank(taskCreator);
        jury.createTask(params);
        jury.createTask(params);
        jury.createTask(params);
        vm.stopPrank();

        bytes32[] memory validations = jury.getAgentValidations(AGENT_ID);
        assertEq(validations.length, 3);
    }
}
