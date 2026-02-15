// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {Test, console} from "forge-std/Test.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract MySBTMock {
    mapping(uint256 => address) private _owners;
    mapping(uint256 => bool) private _revoked;

    function mint(address to, uint256 tokenId) external {
        require(to != address(0), "Invalid to");
        require(_owners[tokenId] == address(0), "Already minted");
        _owners[tokenId] = to;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address owner = _owners[tokenId];
        require(owner != address(0), "NOT_MINTED");
        return owner;
    }

    function isRevoked(uint256 tokenId) external view returns (bool) {
        address owner = _owners[tokenId];
        require(owner != address(0), "NOT_MINTED");
        return _revoked[tokenId];
    }

    function setRevoked(uint256 tokenId, bool revoked) external {
        address owner = _owners[tokenId];
        require(owner != address(0), "NOT_MINTED");
        _revoked[tokenId] = revoked;
    }
}

contract JuryContractTest is Test {
    JuryContract public jury;
    ERC20Mock public stakingToken;
    MySBTMock public sbt;

    address public mySBT;
    address public juror1 = address(0x1001);
    address public juror2 = address(0x1002);
    address public juror3 = address(0x1003);
    address public taskCreator = address(0x2001);

    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant AGENT_ID = 1;

    function setUp() public {
        // Deploy mock staking token
        stakingToken = new ERC20Mock("Test Token", "TEST", 18);

        sbt = new MySBTMock();
        sbt.mint(taskCreator, AGENT_ID);
        mySBT = address(sbt);

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

    function test_Paused_BlocksStateChanges() public {
        jury.setPaused(true);

        vm.prank(juror1);
        vm.expectRevert(bytes("Paused"));
        jury.registerJuror(MIN_STAKE);

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
        vm.expectRevert(bytes("Paused"));
        jury.createTask(params);

        vm.prank(taskCreator);
        vm.expectRevert(bytes("Paused"));
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://req", keccak256("req"));
    }

    function test_JurorRegistrationFailsWithLowStake() public {
        vm.prank(juror1);
        vm.expectRevert("Stake too low");
        jury.registerJuror(MIN_STAKE - 1);
    }

    function test_JurorRegistrationRequiresRoleWhenEnabled() public {
        jury.setRequireJurorRole(true);

        vm.prank(juror1);
        vm.expectRevert("Missing role");
        jury.registerJuror(MIN_STAKE);

        jury.grantRole(jury.ROLE_JUROR(), juror1);

        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);

        (bool isActive, uint256 stake) = jury.isActiveJuror(juror1);
        assertTrue(isActive);
        assertEq(stake, MIN_STAKE);
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

    function test_DeriveValidationRequestHash() public {
        bytes32 taskId = keccak256("task-id");
        bytes32 tag = bytes32("QUALITY");
        string memory requestUri = "ipfs://request";
        bytes32 expected = keccak256(abi.encode(block.chainid, taskId, AGENT_ID, address(jury), tag, requestUri));
        bytes32 actual = jury.deriveValidationRequestHash(taskId, AGENT_ID, address(jury), tag, requestUri);
        assertEq(actual, expected);
    }

    function test_CreateTaskRejectsRevokedAgentId() public {
        sbt.setRevoked(AGENT_ID, true);
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
        vm.expectRevert("Invalid agentId");
        jury.createTask(params);
    }

    function test_ValidationRequestRejectsRevokedAgentId() public {
        sbt.setRevoked(AGENT_ID, true);
        bytes32 requestHash = keccak256("revoked-agent");
        vm.prank(taskCreator);
        vm.expectRevert("Invalid agentId");
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", requestHash);
    }

    function test_TagRoleGatesValidationResponse() public {
        bytes32 tag = bytes32("TAG");
        bytes32 role = keccak256("ROLE_TAG_VALIDATOR");
        jury.setTagRole(tag, role);

        bytes32 requestHash = keccak256("test-request");

        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", requestHash);

        address validator = address(0xBEEF);
        stakingToken.mint(validator, 1000 ether);
        vm.prank(validator);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(validator);
        jury.registerJuror(MIN_STAKE);

        vm.prank(validator);
        vm.expectRevert("Missing role");
        jury.validationResponse(requestHash, 80, "ipfs://resp", bytes32(0), tag);

        jury.grantRole(role, validator);

        vm.prank(validator);
        jury.validationResponse(requestHash, 80, "ipfs://resp", bytes32(0), tag);

        (address validatorAddress, uint256 agentId, uint8 response, bytes32 statusTag, uint256 lastUpdate) =
            jury.getValidationStatus(requestHash);
        assertEq(validatorAddress, validator);
        assertEq(agentId, AGENT_ID);
        assertEq(response, 80);
        assertEq(statusTag, tag);
        assertEq(lastUpdate, block.timestamp);
    }

    function test_ValidationResponseRejectsRequester() public {
        bytes32 requestHash = keccak256("request-self-validate");
        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", requestHash);

        stakingToken.mint(taskCreator, 1000 ether);
        vm.prank(taskCreator);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(taskCreator);
        jury.registerJuror(MIN_STAKE);

        vm.prank(taskCreator);
        vm.expectRevert("Conflict of interest");
        jury.validationResponse(requestHash, 80, "ipfs://resp", bytes32(0), bytes32("TAG"));
    }

    function test_ValidationResponseRejectsAgentOwner() public {
        uint256 agentId = 2;
        sbt.mint(juror1, agentId);

        bytes32 requestHash = keccak256("request-agent-owner");
        vm.prank(taskCreator);
        jury.validationRequest(address(jury), agentId, "ipfs://request", requestHash);

        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror1);
        vm.expectRevert("Conflict of interest");
        jury.validationResponse(requestHash, 80, "ipfs://resp", bytes32(0), bytes32("TAG"));
    }

    function test_ValidationResponseRejectsInvalidScore() public {
        address validator = address(0xBEEF);
        stakingToken.mint(validator, 1000 ether);
        vm.prank(validator);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(validator);
        jury.registerJuror(MIN_STAKE);

        bytes32 requestHash = keccak256("invalid-score");
        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", requestHash);

        vm.prank(validator);
        vm.expectRevert("Invalid response score");
        jury.validationResponse(requestHash, 101, "ipfs://resp", bytes32(0), bytes32("TAG"));
    }

    function test_VoteRejectsTaskCreator() public {
        stakingToken.mint(taskCreator, 1000 ether);
        vm.prank(taskCreator);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(taskCreator);
        jury.registerJuror(MIN_STAKE);

        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: AGENT_ID,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "ipfs://QmEvidence",
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 1,
            consensusThreshold: 5000
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);
        vm.prank(taskCreator);
        jury.submitEvidence(taskHash, "ipfs://QmEvidence");

        vm.prank(taskCreator);
        vm.expectRevert("Conflict of interest");
        jury.vote(taskHash, 85, "");
    }

    function test_VoteRejectsAgentOwner() public {
        uint256 agentId = 2;
        sbt.mint(juror1, agentId);

        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);

        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: agentId,
            taskType: IJuryContract.TaskType.SIMPLE_VERIFICATION,
            evidenceUri: "ipfs://QmEvidence",
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 1,
            consensusThreshold: 5000
        });

        vm.prank(taskCreator);
        bytes32 taskHash = jury.createTask(params);
        vm.prank(taskCreator);
        jury.submitEvidence(taskHash, "ipfs://QmEvidence");

        vm.prank(juror1);
        vm.expectRevert("Conflict of interest");
        jury.vote(taskHash, 85, "");
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
        bytes32 taskId = keccak256("task-id");
        bytes32 tag = bytes32("QUALITY");
        string memory requestUri = "ipfs://request";
        bytes32 requestHash = jury.deriveValidationRequestHash(taskId, AGENT_ID, address(jury), tag, requestUri);

        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, requestUri, requestHash);

        bytes32[] memory requests = jury.getValidatorRequests(address(jury));
        assertEq(requests.length, 1);

        bytes32 storedRequestHash = requests[0];
        IJuryContract.Task memory task = jury.getTask(requestHash);
        assertEq(task.agentId, AGENT_ID);
        assertEq(task.evidenceUri, requestUri);
        assertEq(uint8(task.status), uint8(IJuryContract.TaskStatus.PENDING));
        assertEq(storedRequestHash, requestHash);
    }

    function test_ValidationRequestRejectsUnsupportedValidator() public {
        vm.prank(taskCreator);
        vm.expectRevert("Unsupported validator");
        jury.validationRequest(address(0xBEEF), AGENT_ID, "ipfs://request", bytes32(0));
    }

    function test_ValidationRequestRejectsInvalidAgentId() public {
        bytes32 taskId = keccak256("task-id");
        bytes32 tag = bytes32("QUALITY");
        string memory requestUri = "ipfs://request";
        bytes32 requestHash = jury.deriveValidationRequestHash(taskId, 999, address(jury), tag, requestUri);

        vm.prank(taskCreator);
        vm.expectRevert("Invalid agentId");
        jury.validationRequest(address(jury), 999, requestUri, requestHash);
    }

    function test_ValidationRequestRequiresRoleWhenEnabled() public {
        jury.setRequireValidationRequesterRole(true);

        bytes32 taskId = keccak256("task-id");
        bytes32 tag = bytes32("QUALITY");
        string memory requestUri = "ipfs://request";
        bytes32 requestHash = jury.deriveValidationRequestHash(taskId, AGENT_ID, address(jury), tag, requestUri);

        vm.prank(taskCreator);
        vm.expectRevert("Missing role");
        jury.validationRequest(address(jury), AGENT_ID, requestUri, requestHash);

        jury.grantRole(jury.ROLE_VALIDATION_REQUESTER(), taskCreator);

        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, requestUri, requestHash);

        bytes32[] memory requests = jury.getValidatorRequests(address(jury));
        assertEq(requests.length, 1);
    }

    function test_ValidationRequestRequiresNonZeroRequestHashWhenEnabled() public {
        jury.setRequireNonZeroValidationRequestHash(true);

        vm.prank(taskCreator);
        vm.expectRevert("requestHash required");
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", bytes32(0));

        bytes32 requestHash = keccak256("request");
        vm.prank(taskCreator);
        jury.validationRequest(address(jury), AGENT_ID, "ipfs://request", requestHash);

        bytes32[] memory requests = jury.getValidatorRequests(address(jury));
        assertEq(requests.length, 1);
        assertEq(requests[0], requestHash);
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
