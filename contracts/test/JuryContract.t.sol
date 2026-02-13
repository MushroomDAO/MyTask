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

    function test_ValidationRequestCreatesTaskAndAssignsToValidator() public {
        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", bytes32(0));

        bytes32[] memory requests = jury.getValidatorRequests(address(jury));
        assertEq(requests.length, 1);

        bytes32 requestHash = requests[0];
        IJuryContract.Task memory task = jury.getTask(requestHash);
        assertEq(task.agentId, AGENT_ID);
        assertEq(task.evidenceUri, "ipfs://request");
        assertEq(uint8(task.status), uint8(IJuryContract.TaskStatus.PENDING));
    }

    function test_ValidationRequestRejectsUnsupportedValidator() public {
        vm.prank(taskCreator);
        vm.expectRevert("Unsupported validator");
        jury.validationRequest(address(0xBEEF), AGENT_ID, "ipfs://request", bytes32(0));
    }

    function test_GetSummaryFiltersByTagAndValidator() public {
        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);

        IJuryContract.TaskParams memory p1 = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "ipfs://e1",
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 1,
            consensusThreshold: 0
        });
        IJuryContract.TaskParams memory p2 = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.CONSENSUS_REQUIRED,
            evidenceUri: "ipfs://e2",
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 1,
            consensusThreshold: 0
        });

        vm.startPrank(taskCreator);
        bytes32 h1 = jury.createTask(p1);
        bytes32 h2 = jury.createTask(p2);
        jury.submitEvidence(h1, "ipfs://e1");
        jury.submitEvidence(h2, "ipfs://e2");
        vm.stopPrank();

        vm.prank(juror1);
        jury.vote(h1, 80, "");
        vm.prank(juror1);
        jury.vote(h2, 100, "");

        jury.finalizeTask(h1);
        jury.finalizeTask(h2);

        address[] memory validators = new address[](1);
        validators[0] = address(jury);

        (uint64 countSimple, uint8 avgSimple) = jury.getSummary(
            AGENT_ID, validators, bytes32(uint256(uint8(IJuryContract.TaskType.SIMPLE_VERIFICATION) + 1))
        );
        assertEq(countSimple, 1);
        assertEq(avgSimple, 80);

        address[] memory wrongValidators = new address[](1);
        wrongValidators[0] = address(0xBEEF);
        (uint64 countWrong, uint8 avgWrong) = jury.getSummary(
            AGENT_ID, wrongValidators, bytes32(uint256(uint8(IJuryContract.TaskType.SIMPLE_VERIFICATION) + 1))
        );
        assertEq(countWrong, 0);
        assertEq(avgWrong, 0);
    }

    function test_LinkReceiptToValidation() public {
        vm.prank(taskCreator);
        bytes32 requestHash = keccak256(abi.encodePacked("request-with-receipt"));
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", requestHash);

        bytes32 receiptId = keccak256("receipt-1");

        vm.prank(taskCreator);
        jury.linkReceiptToValidation(requestHash, receiptId, "ipfs://receipt-1");

        bytes32[] memory receipts = jury.getValidationReceipts(requestHash);
        assertEq(receipts.length, 1);
        assertEq(receipts[0], receiptId);

        vm.prank(taskCreator);
        jury.linkReceiptToValidation(requestHash, receiptId, "ipfs://receipt-1");
        receipts = jury.getValidationReceipts(requestHash);
        assertEq(receipts.length, 1);

        vm.prank(address(0xBEEF));
        vm.expectRevert("Not task creator");
        jury.linkReceiptToValidation(requestHash, keccak256("receipt-2"), "ipfs://receipt-2");
    }
}
