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

    address public sponsor = address(0x1);
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
        token.mint(sponsor, 10000 ether);

        // Approve tokens
        vm.prank(sponsor);
        token.approve(address(escrow), type(uint256).max);
    }

    // ====================================
    // Task Creation Tests
    // ====================================

    function test_CreateTask() public {
        bytes32 taskId = _createTask();

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);

        assertEq(task.sponsor, sponsor);
        assertEq(task.reward, REWARD);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Open));
        assertEq(token.balanceOf(address(escrow)), REWARD);
    }

    function test_CreateTask_RevertZeroReward() public {
        vm.prank(sponsor);
        vm.expectRevert(TaskEscrowV2.ZeroAmount.selector);
        escrow.createTask(address(token), 0, block.timestamp + 7 days, "ipfs://meta", bytes32("SIMPLE"));
    }

    function test_CreateTask_RevertInvalidDeadline() public {
        vm.prank(sponsor);
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
        bytes32 structHash = keccak256(
            abi.encode(
                escrow.ACCEPT_TASK_TYPEHASH(),
                taskId,
                taskorSigner,
                nonce,
                deadline
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash)
        );

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

        bytes32 structHash = keccak256(
            abi.encode(escrow.ACCEPT_TASK_TYPEHASH(), taskId, taskorSigner, nonce, deadline)
        );
        bytes32 digest = keccak256(
            abi.encodePacked("\x19\x01", escrow.DOMAIN_SEPARATOR(), structHash)
        );

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

        // Sponsor challenges
        vm.deal(sponsor, 1 ether);
        vm.prank(sponsor);
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

        vm.deal(sponsor, 1 ether);
        vm.prank(sponsor);
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

        vm.deal(sponsor, 1 ether);
        vm.prank(sponsor);
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

        // Sponsor approves early
        vm.prank(sponsor);
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

        // Taskor: 70% = 700
        assertEq(token.balanceOf(taskor), taskorBalanceBefore + 700 ether);
        // Supplier: negotiated fee = 150
        assertEq(token.balanceOf(supplier), supplierBalanceBefore + SUPPLIER_FEE);
    }

    // ====================================
    // Cancellation Tests
    // ====================================

    function test_CancelTask() public {
        bytes32 taskId = _createTask();

        uint256 balanceBefore = token.balanceOf(sponsor);

        vm.prank(sponsor);
        escrow.cancelTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Refunded));
        assertEq(token.balanceOf(sponsor), balanceBefore + REWARD);
    }

    function test_CancelTask_RevertAfterAcceptance() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(sponsor);
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

    // ====================================
    // Helper Functions
    // ====================================

    function _createTask() internal returns (bytes32) {
        vm.prank(sponsor);
        return escrow.createTask(
            address(token),
            REWARD,
            block.timestamp + 7 days,
            "ipfs://task-metadata",
            bytes32("SIMPLE")
        );
    }
}
