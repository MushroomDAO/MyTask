// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {TaskEscrowV2} from "../src/TaskEscrowV2.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract TaskEscrowV2Test is Test {
    TaskEscrowV2 public escrow;
    JuryContract public jury;
    ERC20Mock public token;
    ERC20Mock public stakingToken;

    address public community = address(0x1);
    address public taskor = address(0x2);
    address public supplier = address(0x3);
    address public relayer = address(0x4);
    address public feeRecipient = address(0x5);
    address public mySBT = address(0x6);

    uint256 public constant REWARD = 1000 ether;
    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant SUPPLIER_FEE = 150 ether;

    // For EIP-712 signatures
    uint256 public taskorPrivateKey = 0x12345;
    address public taskorSigner;

    function setUp() public {
        taskorSigner = vm.addr(taskorPrivateKey);

        // Deploy tokens
        token = new ERC20Mock("USDC", "USDC", 18);
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);

        // Deploy JuryContract
        jury = new JuryContract(mySBT, address(stakingToken), MIN_STAKE);

        // Deploy TaskEscrowV2
        escrow = new TaskEscrowV2(address(jury), feeRecipient);

        // Setup accounts
        token.mint(community, 10000 ether);

        // Approve tokens
        vm.prank(community);
        token.approve(address(escrow), type(uint256).max);
    }

    // ====================================
    // Task Creation Tests
    // ====================================

    function test_OwnerControls() public {
        assertEq(escrow.owner(), address(this));

        escrow.setPaused(true);
        assertTrue(escrow.paused());

        escrow.setPaused(false);
        assertFalse(escrow.paused());

        escrow.setFeeRecipient(address(0xBEEF));
        assertEq(escrow.feeRecipient(), address(0xBEEF));

        escrow.setChallengePeriod(1 days);
        assertEq(escrow.getChallengePeriod(), 1 days);
    }

    function test_OwnerControls_RevertForNonOwner() public {
        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.NotOwner.selector);
        escrow.setPaused(true);

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.NotOwner.selector);
        escrow.setFeeRecipient(address(0xBEEF));

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.NotOwner.selector);
        escrow.setChallengePeriod(1 days);
    }

    function test_TransferOwnership() public {
        address newOwner = address(0xBEEF);
        escrow.transferOwnership(newOwner);
        assertEq(escrow.owner(), newOwner);

        vm.expectRevert(TaskEscrowV2.NotOwner.selector);
        escrow.setPaused(true);

        vm.prank(newOwner);
        escrow.setPaused(true);
        assertTrue(escrow.paused());
    }

    function test_Paused_BlocksStateChanges() public {
        escrow.setPaused(true);

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.PausedError.selector);
        escrow.createTask(address(token), REWARD, block.timestamp + 7 days, "ipfs://meta", bytes32("SIMPLE"));

        escrow.setPaused(false);
        bytes32 taskId = _createTask();

        escrow.setPaused(true);

        vm.prank(taskor);
        vm.expectRevert(TaskEscrowV2.PausedError.selector);
        escrow.acceptTask(taskId);
    }

    function test_CreateTask() public {
        bytes32 taskId = _createTask();

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);

        assertEq(task.community, community);
        assertEq(task.reward, REWARD);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Open));
        assertEq(token.balanceOf(address(escrow)), REWARD);
    }

    function test_CreateTask_RevertZeroReward() public {
        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.ZeroAmount.selector);
        escrow.createTask(address(token), 0, block.timestamp + 7 days, "ipfs://meta", bytes32("SIMPLE"));
    }

    function test_CreateTask_RevertInvalidDeadline() public {
        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.InvalidDeadline.selector);
        escrow.createTask(address(token), REWARD, block.timestamp - 1, "ipfs://meta", bytes32("SIMPLE"));
    }

    // ====================================
    // Task Acceptance Tests
    // ====================================

    function test_AcceptTask() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(task.taskor, taskor);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Accepted));
    }

    function test_AcceptTask_RevertExpired() public {
        bytes32 taskId = _createTask();

        vm.warp(block.timestamp + 8 days);

        vm.prank(taskor);
        vm.expectRevert(TaskEscrowV2.TaskExpired.selector);
        escrow.acceptTask(taskId);
    }

    // ====================================
    // EIP-712 Signature Tests (from PayBot)
    // ====================================

    function test_AcceptTaskWithSignature() public {
        bytes32 taskId = _createTask();

        uint256 deadline = block.timestamp + 1 hours;
        uint256 nonce = escrow.nonces(taskorSigner);

        // Create EIP-712 signature
        bytes32 structHash = keccak256(abi.encode(escrow.ACCEPT_TASK_TYPEHASH(), taskId, taskorSigner, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(taskorPrivateKey, digest);

        // Relayer submits signature
        vm.prank(relayer);
        escrow.acceptTaskWithSignature(taskId, taskorSigner, deadline, v, r, s);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(task.taskor, taskorSigner);
        assertEq(escrow.nonces(taskorSigner), nonce + 1);
    }

    function test_AcceptTaskWithSignature_RevertInvalidSignature() public {
        bytes32 taskId = _createTask();

        uint256 deadline = block.timestamp + 1 hours;

        // Wrong signer
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x99999, keccak256("wrong"));

        vm.prank(relayer);
        vm.expectRevert(TaskEscrowV2.InvalidSignature.selector);
        escrow.acceptTaskWithSignature(taskId, taskorSigner, deadline, v, r, s);
    }

    function test_AcceptTaskWithSignature_RevertExpiredSignature() public {
        bytes32 taskId = _createTask();

        uint256 deadline = block.timestamp - 1; // Already expired
        uint256 nonce = escrow.nonces(taskorSigner);

        bytes32 structHash = keccak256(abi.encode(escrow.ACCEPT_TASK_TYPEHASH(), taskId, taskorSigner, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash));

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(taskorPrivateKey, digest);

        vm.prank(relayer);
        vm.expectRevert(TaskEscrowV2.SignatureExpired.selector);
        escrow.acceptTaskWithSignature(taskId, taskorSigner, deadline, v, r, s);
    }

    // ====================================
    // Challenge Period Tests (from PointsRecord)
    // ====================================

    function test_SubmitWork_StartsChallengePeriod() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Submitted));
        assertEq(task.challengeDeadline, block.timestamp + escrow.getChallengePeriod());
        assertTrue(escrow.isInChallengePeriod(taskId));
    }

    function test_ChallengeWork() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        // Community challenges
        vm.deal(community, 1 ether);
        vm.prank(community);
        escrow.challengeWork{value: 0.01 ether}(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Challenged));
        assertEq(task.challengeStake, 0.01 ether);
    }

    function test_ChallengeWork_RevertInsufficientStake() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        vm.deal(community, 1 ether);
        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.InsufficientChallengeStake.selector);
        escrow.challengeWork{value: 0.001 ether}(taskId); // Below minimum
    }

    function test_ChallengeWork_RevertAfterPeriod() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        // Fast forward past challenge period
        vm.warp(block.timestamp + 4 days);

        vm.deal(community, 1 ether);
        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.ChallengePeriodExpired.selector);
        escrow.challengeWork{value: 0.01 ether}(taskId);
    }

    // ====================================
    // Auto-Finalization Tests (from PointsRecord)
    // ====================================

    function test_FinalizeTask_AutoAfterChallengePeriod() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        // Cannot finalize during challenge period
        assertFalse(escrow.canFinalize(taskId));

        // Fast forward past challenge period
        vm.warp(block.timestamp + 4 days);

        assertTrue(escrow.canFinalize(taskId));

        uint256 taskorBalanceBefore = token.balanceOf(taskor);

        // Anyone can finalize
        escrow.finalizeTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));

        // Taskor received 84% (70% + 70% of unused 20%)
        assertEq(token.balanceOf(taskor), taskorBalanceBefore + 840 ether);
    }

    function test_FinalizeTask_RevertDuringChallengePeriod() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        vm.expectRevert(TaskEscrowV2.ChallengePeriodNotOver.selector);
        escrow.finalizeTask(taskId);
    }

    function test_FinalizeTask_RevertWhenValidationsNotSatisfied() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        bytes32 tag = bytes32("TAG");
        vm.prank(community);
        escrow.setTaskValidationRequirement(taskId, tag, 1, 50);

        bytes32 requestHash = keccak256("req-1");
        vm.prank(community);
        jury.validationRequest(address(jury), 1, "ipfs://req-1", requestHash);

        vm.prank(community);
        escrow.addTaskValidationRequest(taskId, requestHash);

        vm.warp(block.timestamp + 4 days);

        vm.expectRevert(TaskEscrowV2.ValidationsNotSatisfied.selector);
        escrow.finalizeTask(taskId);

        address validator = address(0xBEEF);
        stakingToken.mint(validator, 1000 ether);
        vm.prank(validator);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(validator);
        jury.registerJuror(MIN_STAKE);

        vm.prank(validator);
        jury.validationResponse(requestHash, 80, "ipfs://resp-1", bytes32(0), tag);

        escrow.finalizeTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));
    }

    function test_FinalizeTask_RevertWhenUniqueValidatorsNotSatisfied() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        bytes32 tag = bytes32("TAG");
        vm.prank(community);
        escrow.setTaskValidationRequirementWithValidators(taskId, tag, 2, 50, 2);

        bytes32 requestHash1 = keccak256("req-1");
        bytes32 requestHash2 = keccak256("req-2");

        vm.prank(community);
        jury.validationRequest(address(jury), 1, "ipfs://req-1", requestHash1);
        vm.prank(community);
        jury.validationRequest(address(jury), 1, "ipfs://req-2", requestHash2);

        vm.prank(community);
        escrow.addTaskValidationRequest(taskId, requestHash1);
        vm.prank(community);
        escrow.addTaskValidationRequest(taskId, requestHash2);

        address validator1 = address(0xBEEF);
        address validator2 = address(0xCAFE);
        stakingToken.mint(validator1, 1000 ether);
        stakingToken.mint(validator2, 1000 ether);
        vm.prank(validator1);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(validator2);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(validator1);
        jury.registerJuror(MIN_STAKE);
        vm.prank(validator2);
        jury.registerJuror(MIN_STAKE);

        vm.prank(validator1);
        jury.validationResponse(requestHash1, 80, "ipfs://resp-1", bytes32(0), tag);
        vm.prank(validator1);
        jury.validationResponse(requestHash2, 80, "ipfs://resp-2", bytes32(0), tag);

        vm.warp(block.timestamp + 4 days);

        vm.expectRevert(TaskEscrowV2.ValidationsNotSatisfied.selector);
        escrow.finalizeTask(taskId);

        vm.prank(validator2);
        jury.validationResponse(requestHash2, 80, "ipfs://resp-3", bytes32(0), tag);

        escrow.finalizeTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));
    }

    // ====================================
    // Early Approval Tests
    // ====================================

    function test_ApproveWork_EarlyFinalization() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        uint256 taskorBalanceBefore = token.balanceOf(taskor);

        // Community approves early
        vm.prank(community);
        escrow.approveWork(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));
        assertEq(token.balanceOf(taskor), taskorBalanceBefore + 840 ether);
    }

    // ====================================
    // Supplier Tests
    // ====================================

    function test_AssignSupplier() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, SUPPLIER_FEE);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(task.supplier, supplier);
        assertEq(task.supplierFee, SUPPLIER_FEE);
    }

    function test_FinalizeWithSupplier() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, SUPPLIER_FEE);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        vm.warp(block.timestamp + 4 days);

        uint256 taskorBalanceBefore = token.balanceOf(taskor);
        uint256 supplierBalanceBefore = token.balanceOf(supplier);

        escrow.finalizeTask(taskId);

        // Supplier share cap: 20% of 1000 = 200
        // Supplier fee: 150, unused supplier share: 50 -> split 70/30 between taskor and jury
        // Taskor: 700 + 35 = 735
        assertEq(token.balanceOf(taskor), taskorBalanceBefore + 735 ether);
        // Supplier: negotiated fee = 150
        assertEq(token.balanceOf(supplier), supplierBalanceBefore + SUPPLIER_FEE);
    }

    // ====================================
    // Cancellation Tests
    // ====================================

    function test_CancelTask() public {
        bytes32 taskId = _createTask();

        uint256 balanceBefore = token.balanceOf(community);

        vm.prank(community);
        escrow.cancelTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Refunded));
        assertEq(token.balanceOf(community), balanceBefore + REWARD);
    }

    function test_CancelTask_RevertAfterAcceptance() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.InvalidTaskState.selector);
        escrow.cancelTask(taskId);
    }

    // ====================================
    // View Functions Tests
    // ====================================

    function test_GetDistributionShares() public view {
        TaskEscrowV2.DistributionShares memory shares = escrow.getDistributionShares();

        assertEq(shares.taskorShare, 7000);
        assertEq(shares.supplierShare, 2000);
        assertEq(shares.juryShare, 1000);
    }

    function test_GetChallengePeriod() public view {
        assertEq(escrow.getChallengePeriod(), 3 days);
    }

    function test_LinkReceipt_AllowsParticipantsAndDedupes() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        bytes32 receiptId = keccak256("receipt-1");

        vm.prank(taskor);
        escrow.linkReceipt(taskId, receiptId, "ipfs://receipt-1");

        bytes32[] memory receipts = escrow.getTaskReceipts(taskId);
        assertEq(receipts.length, 1);
        assertEq(receipts[0], receiptId);

        vm.prank(taskor);
        escrow.linkReceipt(taskId, receiptId, "ipfs://receipt-1");

        receipts = escrow.getTaskReceipts(taskId);
        assertEq(receipts.length, 1);

        vm.prank(address(0xBEEF));
        vm.expectRevert(TaskEscrowV2.NotParticipant.selector);
        escrow.linkReceipt(taskId, keccak256("receipt-2"), "ipfs://receipt-2");
    }

    function test_TaskPolicy_ReceiptLimit() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(community);
        escrow.setTaskPolicy(taskId, 1, 0);

        vm.prank(taskor);
        escrow.linkReceipt(taskId, keccak256("r-1"), "ipfs://r-1");

        vm.prank(taskor);
        vm.expectRevert(TaskEscrowV2.PolicyViolation.selector);
        escrow.linkReceipt(taskId, keccak256("r-2"), "ipfs://r-2");
    }

    function test_TaskPolicy_ValidationRequestLimit() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(community);
        escrow.setTaskPolicy(taskId, 0, 1);

        vm.prank(taskor);
        escrow.addTaskValidationRequest(taskId, keccak256("req-1"));

        vm.prank(taskor);
        vm.expectRevert(TaskEscrowV2.PolicyViolation.selector);
        escrow.addTaskValidationRequest(taskId, keccak256("req-2"));
    }

    function test_Lifecycle_WithValidationGating_AndReceiptsLinked() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        bytes32 taskReceiptId = keccak256("task-receipt");
        vm.prank(taskor);
        escrow.linkReceipt(taskId, taskReceiptId, "ipfs://task-receipt");

        bytes32 tag = bytes32("TAG");
        vm.prank(community);
        escrow.setTaskValidationRequirementWithValidators(taskId, tag, 1, 50, 1);

        bytes32 requestHash = keccak256("req-1");
        vm.prank(community);
        jury.validationRequest(address(jury), 1, "ipfs://req-1", requestHash);

        bytes32 validationReceiptId = keccak256("validation-receipt");
        vm.prank(community);
        jury.linkReceiptToValidation(requestHash, validationReceiptId, "ipfs://validation-receipt");

        vm.prank(community);
        escrow.addTaskValidationRequest(taskId, requestHash);

        address validator = address(0xBEEF);
        stakingToken.mint(validator, 1000 ether);
        vm.prank(validator);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(validator);
        jury.registerJuror(MIN_STAKE);

        vm.prank(validator);
        jury.validationResponse(requestHash, 80, "ipfs://resp-1", bytes32(0), tag);

        vm.warp(block.timestamp + 4 days);
        escrow.finalizeTask(taskId);

        assertTrue(escrow.validationsSatisfied(taskId));

        bytes32[] memory receipts = escrow.getTaskReceipts(taskId);
        assertEq(receipts.length, 1);
        assertEq(receipts[0], taskReceiptId);

        bytes32[] memory validationReceipts = jury.getValidationReceipts(requestHash);
        assertEq(validationReceipts.length, 1);
        assertEq(validationReceipts[0], validationReceiptId);
    }

    // ====================================
    // Helper Functions
    // ====================================

    function _createTask() internal returns (bytes32) {
        vm.prank(community);
        return
            escrow.createTask(
                address(token), REWARD, block.timestamp + 7 days, "ipfs://task-metadata", bytes32("SIMPLE")
            );
    }
}
