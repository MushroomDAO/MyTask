// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract TaskEscrowTest is Test {
    TaskEscrow public escrow;
    JuryContract public jury;
    ERC20Mock public token;
    ERC20Mock public stakingToken;

    address public sponsor = address(0x1);
    address public taskor = address(0x2);
    address public supplier = address(0x3);
    address public juror1 = address(0x4);
    address public juror2 = address(0x5);
    address public juror3 = address(0x6);
    address public feeRecipient = address(0x7);
    address public mySBT = address(0x8);

    uint256 public constant REWARD = 1000 ether;
    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant SUPPLIER_FEE = 150 ether;

    function setUp() public {
        // Deploy tokens
        token = new ERC20Mock("USDC", "USDC", 18);
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);

        // Deploy JuryContract
        jury = new JuryContract(mySBT, address(stakingToken), MIN_STAKE);

        // Deploy TaskEscrow
        escrow = new TaskEscrow(address(jury), feeRecipient);

        // Setup accounts
        token.mint(sponsor, 10000 ether);
        stakingToken.mint(juror1, 1000 ether);
        stakingToken.mint(juror2, 1000 ether);
        stakingToken.mint(juror3, 1000 ether);

        // Approve tokens
        vm.prank(sponsor);
        token.approve(address(escrow), type(uint256).max);

        vm.prank(juror1);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror2);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror3);
        stakingToken.approve(address(jury), type(uint256).max);

        // Register jurors
        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror2);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror3);
        jury.registerJuror(MIN_STAKE);
    }

    // ====================================
    // Task Creation Tests
    // ====================================

    function test_CreateTask() public {
        bytes32 taskId = _createTask();

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);

        assertEq(task.sponsor, sponsor);
        assertEq(task.reward, REWARD);
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.CREATED));
        assertEq(token.balanceOf(address(escrow)), REWARD);
    }

    function test_CreateTask_RevertZeroReward() public {
        ITaskEscrow.CreateTaskParams memory params = ITaskEscrow.CreateTaskParams({
            token: address(token),
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            metadataUri: "ipfs://task-metadata",
            taskType: bytes32("SIMPLE")
        });

        vm.prank(sponsor);
        vm.expectRevert("Reward must be > 0");
        escrow.createTask(params);
    }

    function test_CreateTask_RevertPastDeadline() public {
        ITaskEscrow.CreateTaskParams memory params = ITaskEscrow.CreateTaskParams({
            token: address(token),
            reward: REWARD,
            deadline: block.timestamp - 1,
            minJurors: 3,
            metadataUri: "ipfs://task-metadata",
            taskType: bytes32("SIMPLE")
        });

        vm.prank(sponsor);
        vm.expectRevert("Invalid deadline");
        escrow.createTask(params);
    }

    // ====================================
    // Task Acceptance Tests
    // ====================================

    function test_AcceptTask() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);
        assertEq(task.taskor, taskor);
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.ACCEPTED));
    }

    function test_AcceptTask_RevertExpired() public {
        bytes32 taskId = _createTask();

        // Fast forward past deadline
        vm.warp(block.timestamp + 8 days);

        vm.prank(taskor);
        vm.expectRevert("Task expired");
        escrow.acceptTask(taskId);
    }

    // ====================================
    // Supplier Assignment Tests
    // ====================================

    function test_AssignSupplier() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, SUPPLIER_FEE);

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);
        assertEq(task.supplier, supplier);
        assertEq(task.supplierFee, SUPPLIER_FEE);
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.IN_PROGRESS));
    }

    function test_AssignSupplier_RevertExcessiveFee() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        // Try to set fee > 20% (supplier share)
        uint256 excessiveFee = (REWARD * 3000) / 10000; // 30%

        vm.prank(taskor);
        vm.expectRevert("Fee exceeds max");
        escrow.assignSupplier(taskId, supplier, excessiveFee);
    }

    // ====================================
    // Evidence Submission Tests
    // ====================================

    function test_SubmitEvidence() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitEvidence(taskId, "ipfs://evidence");

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);
        assertEq(task.evidenceUri, "ipfs://evidence");
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.SUBMITTED));
    }

    // ====================================
    // Cancellation Tests
    // ====================================

    function test_CancelTask() public {
        bytes32 taskId = _createTask();

        uint256 balanceBefore = token.balanceOf(sponsor);

        vm.prank(sponsor);
        escrow.cancelTask(taskId);

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.CANCELLED));
        assertEq(token.balanceOf(sponsor), balanceBefore + REWARD);
    }

    function test_CancelTask_RevertAfterAcceptance() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(sponsor);
        vm.expectRevert("Invalid task state");
        escrow.cancelTask(taskId);
    }

    // ====================================
    // Payout Calculation Tests
    // ====================================

    function test_CalculatePayouts_WithSupplier() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, SUPPLIER_FEE);

        (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout) = escrow.calculatePayouts(taskId);

        // Taskor: 70% of 1000 = 700
        assertEq(taskorPayout, 700 ether);
        // Supplier: negotiated fee = 150
        assertEq(supplierPayout, SUPPLIER_FEE);
        // Jury: 10% of 1000 = 100
        assertEq(juryPayout, 100 ether);
    }

    function test_CalculatePayouts_NoSupplier() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout) = escrow.calculatePayouts(taskId);

        // No supplier - supplier share (200) split: 70% to taskor, 30% to jury
        // Taskor: 700 + 140 = 840
        assertEq(taskorPayout, 840 ether);
        // Supplier: 0
        assertEq(supplierPayout, 0);
        // Jury: 100 + 60 = 160
        assertEq(juryPayout, 160 ether);
    }

    // ====================================
    // View Functions Tests
    // ====================================

    function test_GetTasksBySponsor() public {
        bytes32 taskId1 = _createTask();
        bytes32 taskId2 = _createTask();

        bytes32[] memory tasks = escrow.getTasksBySponsor(sponsor);

        assertEq(tasks.length, 2);
        assertEq(tasks[0], taskId1);
        assertEq(tasks[1], taskId2);
    }

    function test_GetDistributionShares() public {
        ITaskEscrow.DistributionShares memory shares = escrow.getDistributionShares();

        assertEq(shares.taskorShare, 7000);
        assertEq(shares.supplierShare, 2000);
        assertEq(shares.juryShare, 1000);
    }

    // ====================================
    // Dispute Tests
    // ====================================

    function test_RaiseDispute() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, SUPPLIER_FEE);

        vm.prank(supplier);
        escrow.raiseDispute(taskId, "Incomplete delivery");

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.DISPUTED));
    }

    function test_RaiseDispute_RevertNonParticipant() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        address randomUser = address(0x999);
        vm.prank(randomUser);
        vm.expectRevert("Not participant");
        escrow.raiseDispute(taskId, "Fake dispute");
    }

    // ====================================
    // Expired Refund Tests
    // ====================================

    function test_ClaimExpiredRefund() public {
        bytes32 taskId = _createTask();

        // Fast forward past deadline
        vm.warp(block.timestamp + 8 days);

        uint256 balanceBefore = token.balanceOf(sponsor);

        vm.prank(sponsor);
        escrow.claimExpiredRefund(taskId);

        ITaskEscrow.TaskData memory task = escrow.getTask(taskId);
        assertEq(uint256(task.state), uint256(ITaskEscrow.TaskState.EXPIRED));
        assertEq(token.balanceOf(sponsor), balanceBefore + REWARD);
    }

    // ====================================
    // Helper Functions
    // ====================================

    function _createTask() internal returns (bytes32) {
        ITaskEscrow.CreateTaskParams memory params = ITaskEscrow.CreateTaskParams({
            token: address(token),
            reward: REWARD,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            metadataUri: "ipfs://task-metadata",
            taskType: bytes32("SIMPLE")
        });

        vm.prank(sponsor);
        return escrow.createTask(params);
    }
}
