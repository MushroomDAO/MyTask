// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {TaskEscrow} from "../src/TaskEscrow.sol";
import {ITaskEscrow} from "../src/interfaces/ITaskEscrow.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract TaskEscrowLifecycleTest is Test {
    TaskEscrow public escrow;
    JuryContract public jury;
    ERC20Mock public token;
    ERC20Mock public stakingToken;

    address public community = address(0x1);
    address public taskor = address(0x2);
    address public supplier = address(0x3);
    address public juror1 = address(0x4);
    address public juror2 = address(0x5);
    address public juror3 = address(0x6);
    address public feeRecipient = address(0x7);
    address public mySBT = address(0x8);
    address public agent = address(0x9);

    uint256 public constant REWARD = 1000 ether;
    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant SUPPLIER_FEE = 150 ether;

    function setUp() public {
        token = new ERC20Mock("USDC", "USDC", 18);
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);

        jury = new JuryContract(mySBT, address(stakingToken), MIN_STAKE);
        escrow = new TaskEscrow(address(jury), feeRecipient);

        token.mint(community, 10000 ether);
        stakingToken.mint(juror1, 1000 ether);
        stakingToken.mint(juror2, 1000 ether);
        stakingToken.mint(juror3, 1000 ether);

        vm.prank(community);
        token.approve(address(escrow), type(uint256).max);

        vm.prank(juror1);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror2);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror3);
        stakingToken.approve(address(jury), type(uint256).max);

        vm.prank(juror1);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror2);
        jury.registerJuror(MIN_STAKE);
        vm.prank(juror3);
        jury.registerJuror(MIN_STAKE);
    }

    function test_Lifecycle_SubmittedToValidatedToCompleted_WithSupplier() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, SUPPLIER_FEE);

        vm.prank(taskor);
        escrow.submitEvidence(taskId, "ipfs://evidence");

        bytes32 juryTaskHash = _completeJuryTask();

        vm.expectEmit(true, true, false, true, address(escrow));
        emit ITaskEscrow.TaskValidated(taskId, juryTaskHash, 85);

        vm.prank(agent);
        escrow.linkJuryValidation(taskId, juryTaskHash);

        ITaskEscrow.TaskData memory validatedTask = escrow.getTask(taskId);
        assertEq(uint256(validatedTask.state), uint256(ITaskEscrow.TaskState.VALIDATED));
        assertEq(validatedTask.juryTaskHash, juryTaskHash);

        (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout) = escrow.calculatePayouts(taskId);

        uint256 taskorBefore = token.balanceOf(taskor);
        uint256 supplierBefore = token.balanceOf(supplier);
        uint256 juryBefore = token.balanceOf(address(jury));

        escrow.completeTask(taskId);

        ITaskEscrow.TaskData memory completedTask = escrow.getTask(taskId);
        assertEq(uint256(completedTask.state), uint256(ITaskEscrow.TaskState.COMPLETED));

        assertEq(token.balanceOf(taskor), taskorBefore + taskorPayout);
        assertEq(token.balanceOf(supplier), supplierBefore + supplierPayout);
        assertEq(token.balanceOf(address(jury)), juryBefore + juryPayout);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function _createTask() internal returns (bytes32) {
        ITaskEscrow.CreateTaskParams memory params = ITaskEscrow.CreateTaskParams({
            token: address(token),
            reward: REWARD,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            metadataUri: "ipfs://task-metadata",
            taskType: bytes32("SIMPLE")
        });

        vm.prank(community);
        return escrow.createTask(params);
    }

    function _completeJuryTask() internal returns (bytes32 taskHash) {
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: 1,
            taskType: IJuryContract.TaskType.CONSENSUS_REQUIRED,
            evidenceUri: "ipfs://jury-evidence",
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            consensusThreshold: 6600
        });

        vm.prank(agent);
        taskHash = jury.createTask(params);

        vm.prank(agent);
        jury.submitEvidence(taskHash, "ipfs://jury-evidence");

        vm.prank(juror1);
        jury.vote(taskHash, 80, "");
        vm.prank(juror2);
        jury.vote(taskHash, 90, "");
        vm.prank(juror3);
        jury.vote(taskHash, 85, "");

        jury.finalizeTask(taskHash);

        IJuryContract.Task memory task = jury.getTask(taskHash);
        assertEq(uint8(task.status), uint8(IJuryContract.TaskStatus.COMPLETED));
        assertEq(task.finalResponse, 85);
    }
}

