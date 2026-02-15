// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import {TaskEscrowV2} from "../src/TaskEscrowV2.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract TaskEscrowV2Handler is Test {
    TaskEscrowV2 public escrow;
    ERC20Mock public token;
    address public community;
    bytes32[] private _tasks;

    constructor(TaskEscrowV2 _escrow, ERC20Mock _token, address _community) {
        escrow = _escrow;
        token = _token;
        community = _community;

        vm.startPrank(community);
        token.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function getTasks() external view returns (bytes32[] memory) {
        return _tasks;
    }

    function createTask(uint96 reward, uint32 deadlineDelta, bytes32 taskType) external {
        uint256 r = bound(uint256(reward), 1, 10_000 ether);
        uint256 d = bound(uint256(deadlineDelta), 1, 30 days);
        vm.prank(community);
        bytes32 taskId = escrow.createTask(address(token), r, block.timestamp + d, "ipfs://meta", taskType);
        _tasks.push(taskId);
    }

    function setTaskPolicy(uint256 taskIndex, uint64 maxReceipts, uint64 maxValidationRequests) external {
        if (_tasks.length == 0) return;
        bytes32 taskId = _tasks[taskIndex % _tasks.length];
        uint64 mr = uint64(bound(uint256(maxReceipts), 0, 16));
        uint64 mv = uint64(bound(uint256(maxValidationRequests), 0, 16));

        uint256 receiptsLen = escrow.getTaskReceipts(taskId).length;
        uint256 reqsLen = escrow.getTaskValidationRequests(taskId).length;
        if (mr > 0 && receiptsLen > mr) mr = uint64(receiptsLen);
        if (mv > 0 && reqsLen > mv) mv = uint64(reqsLen);

        vm.prank(community);
        escrow.setTaskPolicy(taskId, mr, mv);
    }

    function linkReceipt(uint256 taskIndex, bytes32 receiptId) external {
        if (_tasks.length == 0) return;
        bytes32 taskId = _tasks[taskIndex % _tasks.length];
        bytes32 id = receiptId == bytes32(0) ? keccak256(abi.encode(taskId, "receipt")) : receiptId;
        vm.prank(community);
        try escrow.linkReceipt(taskId, id, "file://receipt.json") {} catch {}
    }

    function addValidationRequest(uint256 taskIndex, bytes32 requestHash) external {
        if (_tasks.length == 0) return;
        bytes32 taskId = _tasks[taskIndex % _tasks.length];
        bytes32 h = requestHash == bytes32(0) ? keccak256(abi.encode(taskId, "request")) : requestHash;
        vm.prank(community);
        try escrow.addTaskValidationRequest(taskId, h) {} catch {}
    }
}

contract TaskEscrowV2InvariantTest is StdInvariant, Test {
    TaskEscrowV2 public escrow;
    JuryContract public jury;
    ERC20Mock public token;
    ERC20Mock public stakingToken;
    TaskEscrowV2Handler public handler;

    address public community = address(0x1);
    address public feeRecipient = address(0x2);
    address public mySBT = address(0x3);

    function setUp() public {
        token = new ERC20Mock("USDC", "USDC", 18);
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);
        jury = new JuryContract(mySBT, address(stakingToken), 100 ether);
        escrow = new TaskEscrowV2(address(jury), feeRecipient);

        token.mint(community, 1_000_000 ether);

        handler = new TaskEscrowV2Handler(escrow, token, community);
        targetContract(address(handler));
    }

    function invariant_receiptsHaveNoDuplicatesAndRespectPolicy() public view {
        bytes32[] memory taskIds = handler.getTasks();
        for (uint256 t = 0; t < taskIds.length; t++) {
            bytes32 taskId = taskIds[t];
            bytes32[] memory receipts = escrow.getTaskReceipts(taskId);
            for (uint256 i = 0; i < receipts.length; i++) {
                for (uint256 j = i + 1; j < receipts.length; j++) {
                    assertTrue(receipts[i] != receipts[j]);
                }
            }
            (uint64 maxReceipts,, bool enabled) = escrow.getTaskPolicy(taskId);
            if (enabled && maxReceipts > 0) {
                assertLe(receipts.length, uint256(maxReceipts));
            }
        }
    }

    function invariant_validationRequestsHaveNoDuplicatesAndRespectPolicy() public view {
        bytes32[] memory taskIds = handler.getTasks();
        for (uint256 t = 0; t < taskIds.length; t++) {
            bytes32 taskId = taskIds[t];
            bytes32[] memory reqs = escrow.getTaskValidationRequests(taskId);
            for (uint256 i = 0; i < reqs.length; i++) {
                for (uint256 j = i + 1; j < reqs.length; j++) {
                    assertTrue(reqs[i] != reqs[j]);
                }
            }
            (, uint64 maxValidationRequests, bool enabled) = escrow.getTaskPolicy(taskId);
            if (enabled && maxValidationRequests > 0) {
                assertLe(reqs.length, uint256(maxValidationRequests));
            }
        }
    }

    function invariant_escrowTokenBalanceEqualsSumRewards() public view {
        bytes32[] memory taskIds = handler.getTasks();
        uint256 sumRewards = 0;
        for (uint256 t = 0; t < taskIds.length; t++) {
            TaskEscrowV2.Task memory task = escrow.getTask(taskIds[t]);
            sumRewards += task.reward;
        }
        assertEq(token.balanceOf(address(escrow)), sumRewards);
    }
}
