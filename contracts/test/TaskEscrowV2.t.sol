// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.23;

import "forge-std/Test.sol";
import {TaskEscrowV2} from "../src/TaskEscrowV2.sol";
import {JuryContract} from "../src/JuryContract.sol";
import {IJuryContract} from "../src/interfaces/IJuryContract.sol";
import {ERC20Mock} from "./mocks/ERC20Mock.sol";

contract TaskEscrowV2Test is Test {
    TaskEscrowV2 public escrow;
    JuryContract public jury;
    ERC20Mock public token;
    ERC20Mock public stakingToken;

    address public community = address(0x1);
    address public taskor = address(0x2);
    address public supplier = address(0x3);
    address public feeRecipient = address(0x5);
    address public mySBT = address(0x6);

    uint256 public constant REWARD = 1000 ether;
    uint256 public constant MIN_STAKE = 100 ether;
    uint256 public constant SUPPLIER_FEE = 150 ether;
    uint256 public constant CHALLENGE_STAKE = 10e18;

    address public juror1 = address(0x11);
    address public juror2 = address(0x12);
    address public juror3 = address(0x13);
    address public agent = address(0x14);

    function setUp() public {
        // Deploy tokens
        token = new ERC20Mock("USDC", "USDC", 18);
        stakingToken = new ERC20Mock("xPNT", "xPNT", 18);

        // Deploy JuryContract
        jury = new JuryContract(mySBT, address(stakingToken), MIN_STAKE);

        // Deploy TaskEscrowV2 (challenge stake = ERC-20 xPNT)
        escrow = new TaskEscrowV2(address(jury), feeRecipient, address(stakingToken));

        // Authorize escrow to register jury-share rewards
        jury.setAuthorizedEscrow(address(escrow), true);

        // Setup accounts
        token.mint(community, 10000 ether);
        stakingToken.mint(community, 1000 ether);

        // Approve tokens
        vm.prank(community);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(community);
        stakingToken.approve(address(escrow), type(uint256).max);
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
    // Supplier Assignment Tests
    // ====================================

    function test_AssignSupplier_RevertFeeExceedsLimit() public {
        bytes32 taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        // Max fee = reward * supplierShare (20%) = 200 ether; anything above must revert
        uint256 maxFee = (REWARD * 2000) / 10000;

        vm.prank(taskor);
        vm.expectRevert(TaskEscrowV2.FeeExceedsLimit.selector);
        escrow.assignSupplier(taskId, supplier, maxFee + 1);

        // Exactly at the cap is accepted
        vm.prank(taskor);
        escrow.assignSupplier(taskId, supplier, maxFee);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(task.supplier, supplier);
        assertEq(task.supplierFee, maxFee);
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
        bytes32 taskId = _createSubmittedTask();

        uint256 communityStakeBefore = stakingToken.balanceOf(community);

        // Community challenges with ERC-20 stake (no ETH involved)
        vm.prank(community);
        escrow.challengeWork(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Challenged));
        assertEq(task.challengeStake, CHALLENGE_STAKE);
        assertEq(stakingToken.balanceOf(community), communityStakeBefore - CHALLENGE_STAKE);
        assertEq(stakingToken.balanceOf(address(escrow)), CHALLENGE_STAKE);
    }

    function test_ChallengeWork_RevertWithoutApproval() public {
        bytes32 taskId = _createSubmittedTask();

        // Revoke stake token approval
        vm.prank(community);
        stakingToken.approve(address(escrow), 0);

        vm.prank(community);
        vm.expectRevert(stdError.arithmeticError);
        escrow.challengeWork(taskId);
    }

    function test_ChallengeWork_RevertInsufficientBalance() public {
        bytes32 taskId = _createSubmittedTask();

        // Drain community's stake token balance
        stakingToken.burn(community, stakingToken.balanceOf(community));

        vm.prank(community);
        vm.expectRevert(stdError.arithmeticError);
        escrow.challengeWork(taskId);
    }

    function test_ChallengeWork_RevertAfterPeriod() public {
        bytes32 taskId = _createSubmittedTask();

        // Fast forward past challenge period
        vm.warp(block.timestamp + 4 days);

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.ChallengePeriodExpired.selector);
        escrow.challengeWork(taskId);
    }

    function test_SetChallengeStakeConfig() public {
        ERC20Mock newToken = new ERC20Mock("PNT", "PNT", 18);
        escrow.setChallengeStakeConfig(address(newToken), 25e18);
        assertEq(escrow.challengeStakeToken(), address(newToken));
        assertEq(escrow.challengeStakeAmount(), 25e18);

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.NotOwner.selector);
        escrow.setChallengeStakeConfig(address(newToken), 1e18);

        vm.expectRevert(TaskEscrowV2.ZeroAddress.selector);
        escrow.setChallengeStakeConfig(address(0), 1e18);

        vm.expectRevert(TaskEscrowV2.ZeroAmount.selector);
        escrow.setChallengeStakeConfig(address(newToken), 0);
    }

    // ====================================
    // Challenge -> Jury Resolution Tests (ERC-20 stake, full flow)
    // ====================================

    function test_ChallengeFlow_JuryApprovesWork_RefundsChallenger_AndCreditsJurors() public {
        bytes32 taskId = _createSubmittedTask();

        vm.prank(community);
        escrow.challengeWork(taskId);

        uint256 communityStakeAfterChallenge = stakingToken.balanceOf(community);
        uint256 taskorBefore = token.balanceOf(taskor);

        // Jury approves the work (avg 85 >= 50)
        bytes32 juryTaskHash = _completeJuryTask(80, 90, 85, 0);

        escrow.linkJuryValidation(taskId, juryTaskHash);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));
        assertEq(task.juryTaskHash, juryTaskHash);

        // Challenger got the ERC-20 stake back
        assertEq(stakingToken.balanceOf(community), communityStakeAfterChallenge + CHALLENGE_STAKE);
        assertEq(stakingToken.balanceOf(address(escrow)), 0);

        // Taskor paid 84% (70% + 70% of unused supplier share)
        assertEq(token.balanceOf(taskor), taskorBefore + 840 ether);

        // Jury share (10% + 30% of unused supplier share = 160) landed on JuryContract
        uint256 juryPayout = 160 ether;
        assertEq(token.balanceOf(address(jury)), juryPayout);

        // ... and was credited equally to the 3 voting jurors (pull pattern)
        uint256 perJuror = juryPayout / 3;
        assertEq(jury.pendingRewards(juror1, address(token)), perJuror);
        assertEq(jury.pendingRewards(juror2, address(token)), perJuror);
        assertEq(jury.pendingRewards(juror3, address(token)), perJuror);
        assertEq(jury.ownerDust(address(token)), juryPayout - perJuror * 3);

        // Jurors can actually claim
        vm.prank(juror1);
        jury.claimRewards(address(token));
        assertEq(token.balanceOf(juror1), perJuror);
        assertEq(jury.pendingRewards(juror1, address(token)), 0);
    }

    function test_ChallengeFlow_JuryRejectsWork_ForfeitsStakeToTaskor() public {
        bytes32 taskId = _createSubmittedTask();

        vm.prank(community);
        escrow.challengeWork(taskId);

        uint256 communityTokenBefore = token.balanceOf(community);
        uint256 taskorStakeBefore = stakingToken.balanceOf(taskor);

        // Jury rejects the work (avg 10 < 50); positiveThreshold=5 so consensus
        // still completes the jury task
        bytes32 juryTaskHash = _completeJuryTask(10, 10, 10, 5);

        escrow.linkJuryValidation(taskId, juryTaskHash);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Refunded));

        // Community got the full reward back
        assertEq(token.balanceOf(community), communityTokenBefore + REWARD);

        // Challenger's ERC-20 stake was forfeited to the taskor
        assertEq(stakingToken.balanceOf(taskor), taskorStakeBefore + CHALLENGE_STAKE);
        assertEq(stakingToken.balanceOf(address(escrow)), 0);
    }

    function test_ChallengeFlow_FeeOnTransferStake_RecordsActualAmount_AndResolves() public {
        // F2: with a fee-on-transfer stake token, challengeStake must be the
        // amount actually received — otherwise the refund would exceed the
        // escrow's real balance and linkJuryValidation would revert forever
        FeeOnTransferTokenMock feeToken = new FeeOnTransferTokenMock();
        escrow.setChallengeStakeConfig(address(feeToken), CHALLENGE_STAKE);

        feeToken.mint(community, CHALLENGE_STAKE);
        vm.prank(community);
        feeToken.approve(address(escrow), type(uint256).max);

        bytes32 taskId = _createSubmittedTask();

        vm.prank(community);
        escrow.challengeWork(taskId);

        // 10% fee burned in transit: escrow received and booked 9e18, not 10e18
        uint256 received = CHALLENGE_STAKE - (CHALLENGE_STAKE * feeToken.FEE_BPS()) / 10000;
        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(task.challengeStake, received);
        assertEq(feeToken.balanceOf(address(escrow)), received);

        // Jury approves the work -> refund path must NOT revert
        bytes32 juryTaskHash = _completeJuryTask(80, 90, 85, 0);
        escrow.linkJuryValidation(taskId, juryTaskHash);

        task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));

        // Escrow fully paid out its real balance; challenger got received minus
        // the outbound transfer fee
        assertEq(feeToken.balanceOf(address(escrow)), 0);
        assertEq(feeToken.balanceOf(community), received - (received * feeToken.FEE_BPS()) / 10000);
    }

    function test_ChallengeWork_ReentrantStakeToken_BlockedByGuard() public {
        // Malicious stake token re-enters createTask during the transferFrom
        // inside challengeWork's balance-snapshot window, depositing ITSELF as
        // the reward token — the exact same-token deposit that would pollute
        // the snapshot. The shared reentrancy guard (createTask is now
        // nonReentrant) must kill the whole call.
        ReentrantStakeTokenMock evil = new ReentrantStakeTokenMock(escrow);
        escrow.setChallengeStakeConfig(address(evil), CHALLENGE_STAKE);

        evil.mint(community, CHALLENGE_STAKE);
        vm.prank(community);
        evil.approve(address(escrow), type(uint256).max);

        bytes32 taskId = _createSubmittedTask();

        vm.prank(community);
        vm.expectRevert(TaskEscrowV2.ReentrancyDetected.selector);
        escrow.challengeWork(taskId);

        // Nothing was booked
        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Submitted));
        assertEq(task.challengeStake, 0);
    }

    function test_ChallengeWork_InflatingStakeToken_CappedAtConfiguredAmount() public {
        // Second line of defense: a token that delivers MORE than requested
        // (simulating a polluted snapshot window) gets capped at the configured
        // stake amount, so resolution can never pay out unrelated funds
        InflatingStakeTokenMock weird = new InflatingStakeTokenMock();
        escrow.setChallengeStakeConfig(address(weird), CHALLENGE_STAKE);

        weird.mint(community, CHALLENGE_STAKE);
        vm.prank(community);
        weird.approve(address(escrow), type(uint256).max);

        bytes32 taskId = _createSubmittedTask();

        vm.prank(community);
        escrow.challengeWork(taskId);

        // Escrow actually received 2x, but only the configured amount is booked
        assertEq(weird.balanceOf(address(escrow)), CHALLENGE_STAKE * 2);
        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(task.challengeStake, CHALLENGE_STAKE);
    }

    function test_ChallengeFlow_ConfigChangeMidChallenge_UsesSnapshotToken() public {
        bytes32 taskId = _createSubmittedTask();

        // Challenge with the original stake token (xPNT)
        vm.prank(community);
        escrow.challengeWork(taskId);

        // Owner switches the stake config mid-challenge
        ERC20Mock newToken = new ERC20Mock("PNT2", "PNT2", 18);
        escrow.setChallengeStakeConfig(address(newToken), 99e18);

        uint256 taskorStakeBefore = stakingToken.balanceOf(taskor);

        // Jury rejects the work -> forfeit must use the SNAPSHOT token (xPNT),
        // with the snapshot amount, not the new config
        bytes32 juryTaskHash = _completeJuryTask(10, 10, 10, 5);
        escrow.linkJuryValidation(taskId, juryTaskHash);

        assertEq(stakingToken.balanceOf(taskor), taskorStakeBefore + CHALLENGE_STAKE);
        assertEq(stakingToken.balanceOf(address(escrow)), 0);
        assertEq(newToken.balanceOf(taskor), 0);
        assertEq(newToken.balanceOf(address(escrow)), 0);
    }

    function test_AutoFinalize_UnchallengedJuryShare_AccruesAsOwnerDust() public {
        // juryTaskHash == 0 path: unchallenged settlement must not revert, and
        // the jury share (no voters to split among) accrues as ownerDust
        bytes32 taskId = _createSubmittedTask();

        vm.warp(block.timestamp + 4 days);
        escrow.finalizeTask(taskId);

        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));
        assertEq(task.juryTaskHash, bytes32(0));

        // Jury share without supplier: 10% + 30% of unused 20% = 160
        uint256 juryPayout = 160 ether;
        assertEq(token.balanceOf(address(jury)), juryPayout);
        assertEq(jury.ownerDust(address(token)), juryPayout);

        // Sweepable by jury admin (this test contract)
        jury.sweepDust(address(token));
        assertEq(token.balanceOf(address(this)), juryPayout);
    }

    function test_ChallengeFlow_AAContractChallenger_ReceivesERC20Refund() public {
        // AA-style smart account whose receive() always reverts: the old native-ETH
        // payable.transfer refund would brick this flow forever
        SmartWalletMock wallet = new SmartWalletMock();

        token.mint(address(wallet), REWARD);
        stakingToken.mint(address(wallet), CHALLENGE_STAKE);

        wallet.exec(address(token), abi.encodeCall(ERC20Mock.approve, (address(escrow), type(uint256).max)));
        wallet.exec(address(stakingToken), abi.encodeCall(ERC20Mock.approve, (address(escrow), type(uint256).max)));

        // Wallet is the community: creates, then challenges its own task
        bytes memory ret = wallet.exec(
            address(escrow),
            abi.encodeCall(
                TaskEscrowV2.createTask,
                (address(token), REWARD, block.timestamp + 7 days, "ipfs://meta", bytes32("SIMPLE"))
            )
        );
        bytes32 taskId = abi.decode(ret, (bytes32));

        vm.prank(taskor);
        escrow.acceptTask(taskId);
        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");

        wallet.exec(address(escrow), abi.encodeCall(TaskEscrowV2.challengeWork, (taskId)));
        assertEq(stakingToken.balanceOf(address(wallet)), 0);

        // Jury approves the work -> stake refund flows back to the AA wallet as
        // an ERC-20 transfer and does NOT revert despite the reverting receive()
        bytes32 juryTaskHash = _completeJuryTask(80, 90, 85, 0);
        escrow.linkJuryValidation(taskId, juryTaskHash);

        assertEq(stakingToken.balanceOf(address(wallet)), CHALLENGE_STAKE);
        TaskEscrowV2.Task memory task = escrow.getTask(taskId);
        assertEq(uint256(task.status), uint256(TaskEscrowV2.TaskStatus.Finalized));
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

    function _createSubmittedTask() internal returns (bytes32 taskId) {
        taskId = _createTask();

        vm.prank(taskor);
        escrow.acceptTask(taskId);

        vm.prank(taskor);
        escrow.submitWork(taskId, "ipfs://evidence");
    }

    function _registerJuror(address juror) internal {
        stakingToken.mint(juror, MIN_STAKE);
        vm.prank(juror);
        stakingToken.approve(address(jury), type(uint256).max);
        vm.prank(juror);
        jury.registerJuror(MIN_STAKE);
    }

    /// @dev Creates and finalizes a jury task with 3 juror votes.
    ///      `positiveThreshold` = 0 uses the default (50); pass a low value to
    ///      reach consensus with low scores (jury-rejects-work scenario).
    function _completeJuryTask(uint8 vote1, uint8 vote2, uint8 vote3, uint8 positiveThreshold)
        internal
        returns (bytes32 juryTaskHash)
    {
        _registerJuror(juror1);
        _registerJuror(juror2);
        _registerJuror(juror3);

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
            positiveThreshold: positiveThreshold
        });

        vm.prank(agent);
        juryTaskHash = jury.createTask(params);

        vm.prank(agent);
        jury.submitEvidence(juryTaskHash, "ipfs://jury-evidence");

        vm.prank(juror1);
        jury.vote(juryTaskHash, vote1, "");
        vm.prank(juror2);
        jury.vote(juryTaskHash, vote2, "");
        vm.prank(juror3);
        jury.vote(juryTaskHash, vote3, "");

        jury.finalizeTask(juryTaskHash);

        IJuryContract.Task memory juryTask = jury.getTask(juryTaskHash);
        assertEq(uint8(juryTask.status), uint8(IJuryContract.TaskStatus.COMPLETED));
    }
}

/**
 * @notice Minimal AA-style smart account: executes arbitrary calls, but its
 *         receive() always reverts — the archetype that bricks payable.transfer
 */
contract SmartWalletMock {
    error NoDirectEth();

    function exec(address target, bytes memory data) external returns (bytes memory) {
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "exec failed");
        return ret;
    }

    receive() external payable {
        revert NoDirectEth();
    }
}

/**
 * @notice Malicious stake token: during the escrow's transferFrom it re-enters
 *         TaskEscrowV2.createTask using ITSELF as the reward token — i.e. it
 *         deposits the same stake token into the escrow inside challengeWork's
 *         balance-snapshot window, the exact vector that would inflate
 *         task.challengeStake. The inner call must revert with
 *         ReentrancyDetected and bubble up.
 */
contract ReentrantStakeTokenMock {
    TaskEscrowV2 public escrow;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool private _attacking;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(TaskEscrowV2 _escrow) {
        escrow = _escrow;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (msg.sender == address(escrow) && !_attacking) {
            _attacking = true;
            // Fully-formed attack: fund and approve ourselves, then deposit
            // THIS same stake token as a task reward inside the snapshot
            // window. Without the shared guard this createTask would move
            // 1 ether of this token into the escrow between balanceBefore and
            // balanceAfter, inflating task.challengeStake by unrelated funds.
            balanceOf[address(this)] += 1 ether;
            allowance[address(this)][address(escrow)] = type(uint256).max;
            escrow.createTask(address(this), 1 ether, block.timestamp + 1 days, "evil", bytes32("EVIL"));
            _attacking = false;
        }
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/**
 * @notice Weird token that credits the recipient DOUBLE the requested amount
 *         on transferFrom — simulates a polluted balance-snapshot window to
 *         exercise challengeWork's defensive cap
 */
contract InflatingStakeTokenMock {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount * 2; // minted bonus lands in the same window
        emit Transfer(from, to, amount * 2);
        return true;
    }
}

/**
 * @notice ERC-20 that burns a 10% fee on every transfer/transferFrom —
 *         recipient receives less than the sent amount
 */
contract FeeOnTransferTokenMock {
    string public name = "FEE";
    string public symbol = "FEE";
    uint8 public decimals = 18;
    uint256 public constant FEE_BPS = 1000; // 10%

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return _move(msg.sender, to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) {
            allowance[from][msg.sender] -= amount;
        }
        return _move(from, to, amount);
    }

    function _move(address from, address to, uint256 amount) internal returns (bool) {
        uint256 fee = (amount * FEE_BPS) / 10000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee; // fee is burned
        emit Transfer(from, to, amount - fee);
        return true;
    }
}
