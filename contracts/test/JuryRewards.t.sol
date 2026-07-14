// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

/**
 * @notice Unit tests for the JuryContract reward pool (MT-1 fund black hole fix):
 *         notifyReward accounting, pull-pattern claims, dust sweeping,
 *         escrow authorization, and reentrancy defenses.
 */
contract JuryRewardsTest is Test {
    JuryContract public jury;
    ERC20Mock public stakingToken;
    ERC20Mock public rewardToken;

    address public mySBT = address(0x6);
    address public escrow = address(0xE5);
    address public juror1 = address(0x11);
    address public juror2 = address(0x12);
    address public juror3 = address(0x13);
    address public agent = address(0x14);

    uint256 public constant MIN_STAKE = 100 ether;

    function setUp() public {
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);
        rewardToken = new ERC20Mock("USDC", "USDC", 18);

        jury = new JuryContract(mySBT, address(stakingToken), MIN_STAKE);
        jury.setAuthorizedEscrow(escrow, true);

        _registerJuror(juror1);
        _registerJuror(juror2);
        _registerJuror(juror3);
    }

    // ====================================
    // Authorization
    // ====================================

    function test_SetAuthorizedEscrow_OnlyAdmin() public {
        vm.prank(juror1);
        vm.expectRevert("Not admin");
        jury.setAuthorizedEscrow(address(0xBEEF), true);

        vm.expectRevert("Invalid escrow");
        jury.setAuthorizedEscrow(address(0), true);

        jury.setAuthorizedEscrow(address(0xBEEF), true);
        assertTrue(jury.authorizedEscrows(address(0xBEEF)));

        jury.setAuthorizedEscrow(address(0xBEEF), false);
        assertFalse(jury.authorizedEscrows(address(0xBEEF)));
    }

    function test_NotifyReward_RevertUnauthorized() public {
        vm.prank(address(0xBAD));
        vm.expectRevert("Not authorized escrow");
        jury.notifyReward(bytes32(0), address(rewardToken), 100 ether);
    }

    function test_NotifyReward_RevertInvalidToken() public {
        vm.prank(escrow);
        vm.expectRevert("Invalid token");
        jury.notifyReward(bytes32(0), address(0), 100 ether);
    }

    // ====================================
    // Reward accounting
    // ====================================

    function test_NotifyReward_SplitsEquallyAmongVoters_DustToOwner() public {
        bytes32 taskHash = _completeJuryTask();

        // 100e18 + 1 does not divide by 3: dust = (100e18 + 1) % 3
        uint256 amount = 100 ether + 1;
        rewardToken.mint(address(jury), amount);

        uint256 perJuror = amount / 3;
        uint256 dust = amount - perJuror * 3;

        vm.prank(escrow);
        vm.expectEmit(true, true, false, true, address(jury));
        emit JuryContract.RewardNotified(taskHash, address(rewardToken), amount, 3);
        jury.notifyReward(taskHash, address(rewardToken), amount);

        assertEq(jury.pendingRewards(juror1, address(rewardToken)), perJuror);
        assertEq(jury.pendingRewards(juror2, address(rewardToken)), perJuror);
        assertEq(jury.pendingRewards(juror3, address(rewardToken)), perJuror);
        assertEq(jury.ownerDust(address(rewardToken)), dust);
        assertGt(dust, 0);
    }

    function test_NotifyReward_NoVoters_AllToOwnerDust() public {
        // taskHash = 0: the unchallenged-escrow-settlement path (no jury task)
        uint256 amount = 50 ether;
        rewardToken.mint(address(jury), amount);

        vm.prank(escrow);
        vm.expectEmit(true, true, false, true, address(jury));
        emit JuryContract.RewardNotified(bytes32(0), address(rewardToken), amount, 0);
        jury.notifyReward(bytes32(0), address(rewardToken), amount);

        assertEq(jury.ownerDust(address(rewardToken)), amount);
        assertEq(jury.pendingRewards(juror1, address(rewardToken)), 0);
    }

    function test_NotifyReward_ZeroAmount_NoOp() public {
        bytes32 taskHash = _completeJuryTask();

        vm.prank(escrow);
        jury.notifyReward(taskHash, address(rewardToken), 0);

        assertEq(jury.pendingRewards(juror1, address(rewardToken)), 0);
        assertEq(jury.ownerDust(address(rewardToken)), 0);
    }

    function test_DuplicateVoteImpossible_NoDoubleAllocation() public {
        // F1 proof: vote() enforces one vote record per juror per task
        // (_hasVoted is set BEFORE the push and re-voting reverts), so
        // notifyReward's per-record split can never double-pay a juror
        bytes32 taskHash = _completeJuryTask();

        // Re-vote by an existing voter reverts — no second record possible
        vm.prank(juror1);
        vm.expectRevert("Already voted");
        jury.vote(taskHash, 100, "");

        // Exactly one record per juror
        IJuryContract.Vote[] memory votes = jury.getVotes(taskHash);
        assertEq(votes.length, 3);
        assertTrue(votes[0].juror != votes[1].juror);
        assertTrue(votes[1].juror != votes[2].juror);
        assertTrue(votes[0].juror != votes[2].juror);

        // Allocation: each juror gets exactly 1/3, nobody is diluted
        uint256 amount = 90 ether;
        rewardToken.mint(address(jury), amount);
        vm.prank(escrow);
        jury.notifyReward(taskHash, address(rewardToken), amount);

        assertEq(jury.pendingRewards(juror1, address(rewardToken)), 30 ether);
        assertEq(jury.pendingRewards(juror2, address(rewardToken)), 30 ether);
        assertEq(jury.pendingRewards(juror3, address(rewardToken)), 30 ether);
    }

    function test_NotifyReward_Accumulates() public {
        bytes32 taskHash = _completeJuryTask();

        rewardToken.mint(address(jury), 60 ether);
        vm.prank(escrow);
        jury.notifyReward(taskHash, address(rewardToken), 30 ether);
        vm.prank(escrow);
        jury.notifyReward(taskHash, address(rewardToken), 30 ether);

        assertEq(jury.pendingRewards(juror1, address(rewardToken)), 20 ether);
    }

    // ====================================
    // Claims
    // ====================================

    function test_ClaimRewards_TransfersAndZeroes() public {
        bytes32 taskHash = _completeJuryTask();
        rewardToken.mint(address(jury), 90 ether);
        vm.prank(escrow);
        jury.notifyReward(taskHash, address(rewardToken), 90 ether);

        vm.prank(juror1);
        vm.expectEmit(true, true, false, true, address(jury));
        emit JuryContract.RewardClaimed(juror1, address(rewardToken), 30 ether);
        jury.claimRewards(address(rewardToken));

        assertEq(rewardToken.balanceOf(juror1), 30 ether);
        assertEq(jury.pendingRewards(juror1, address(rewardToken)), 0);

        // Double claim reverts
        vm.prank(juror1);
        vm.expectRevert("Nothing to claim");
        jury.claimRewards(address(rewardToken));

        // Other jurors unaffected
        vm.prank(juror2);
        jury.claimRewards(address(rewardToken));
        assertEq(rewardToken.balanceOf(juror2), 30 ether);
    }

    function test_ClaimRewards_RevertNothingToClaim() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("Nothing to claim");
        jury.claimRewards(address(rewardToken));
    }

    function test_ClaimRewards_ReentrancyBlocked() public {
        // Malicious token that tries to re-enter claimRewards during transfer
        ReentrantRewardToken evil = new ReentrantRewardToken(jury);
        bytes32 taskHash = _completeJuryTask();

        evil.mint(address(jury), 90 ether);
        vm.prank(escrow);
        jury.notifyReward(taskHash, address(evil), 90 ether);

        vm.prank(juror1);
        jury.claimRewards(address(evil));

        // Reentrant claim inside the transfer failed: only one payout happened
        assertEq(evil.balanceOf(juror1), 30 ether);
        assertEq(jury.pendingRewards(juror1, address(evil)), 0);
        assertTrue(evil.reentryAttempted());
        assertFalse(evil.reentrySucceeded());
    }

    // ====================================
    // Dust sweeping
    // ====================================

    function test_SweepDust_OnlyAdmin() public {
        vm.prank(escrow);
        rewardToken.mint(address(jury), 50 ether);
        vm.prank(escrow);
        jury.notifyReward(bytes32(0), address(rewardToken), 50 ether);

        vm.prank(juror1);
        vm.expectRevert("Not admin");
        jury.sweepDust(address(rewardToken));

        vm.expectEmit(true, true, false, true, address(jury));
        emit JuryContract.DustSwept(address(rewardToken), address(this), 50 ether);
        jury.sweepDust(address(rewardToken));

        assertEq(rewardToken.balanceOf(address(this)), 50 ether);
        assertEq(jury.ownerDust(address(rewardToken)), 0);

        vm.expectRevert("Nothing to sweep");
        jury.sweepDust(address(rewardToken));
    }

    // ====================================
    // Helpers
    // ====================================

    function _registerJuror(address juror) internal {
        stakingToken.mint(juror, MIN_STAKE);
        vm.prank(juror);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror);
        jury.registerJuror(MIN_STAKE);
    }

    function _completeJuryTask() internal returns (bytes32 taskHash) {
        IJuryContract.TaskParams memory params = IJuryContract.TaskParams({
            agentId: 0,
            taskType: IJuryContract.TaskType.CONSENSUS_REQUIRED,
            evidenceUri: "ipfs://jury-evidence",
            reward: 0,
            deadline: block.timestamp + 7 days,
            minJurors: 3,
            consensusThreshold: 6600,
            contextId: bytes32(0),
            contextType: bytes32(0),
            callbackAddress: address(0),
            positiveThreshold: 0
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
    }
}

/**
 * @notice Minimal ERC-20 that attempts to re-enter JuryContract.claimRewards
 *         during transfer, recording whether the reentry succeeded
 */
contract ReentrantRewardToken {
    JuryContract public jury;
    mapping(address => uint256) public balanceOf;
    bool public reentryAttempted;
    bool public reentrySucceeded;

    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(JuryContract _jury) {
        jury = _jury;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);

        if (msg.sender == address(jury) && !reentryAttempted) {
            reentryAttempted = true;
            try jury.claimRewards(address(this)) {
                reentrySucceeded = true;
            } catch {}
        }
        return true;
    }
}
