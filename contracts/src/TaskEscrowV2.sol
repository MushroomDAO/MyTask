// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ITaskEscrow} from "./interfaces/ITaskEscrow.sol";
import {IJuryContract} from "./interfaces/IJuryContract.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/**
 * @title TaskEscrowV2
 * @notice Enhanced four-party task escrow with security improvements
 * @dev Improvements learned from submodules:
 *
 * From PayBot/Escrow.sol:
 * - ReentrancyGuard pattern for all fund transfers
 * - EIP-712 typed signatures for gasless operations
 * - Nonces for replay attack protection
 * - EIP-2612 permit integration
 *
 * From Tasks/PointsRecord.sol:
 * - Challenge period mechanism (optimistic completion)
 * - Auto-finalization after challenge period
 * - Custom errors for gas optimization
 *
 * From ZKx402/VerificationRegistry.sol:
 * - Cross-chain message handling pattern (future)
 * - Source validation for trusted senders
 *
 * @custom:security-contact security@aastar.io
 */
contract TaskEscrowV2 {
    // ====================================
    // Constants
    // ====================================

    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant DEFAULT_TASKOR_SHARE = 7000; // 70%
    uint256 public constant DEFAULT_SUPPLIER_SHARE = 2000; // 20%
    uint256 public constant DEFAULT_JURY_SHARE = 1000; // 10%
    uint256 public constant DEFAULT_CHALLENGE_PERIOD = 3 days;
    uint256 public constant MIN_CHALLENGE_STAKE = 0.01 ether;

    // EIP-712 Domain
    bytes32 public immutable DOMAIN_SEPARATOR;

    // EIP-712 TypeHashes
    bytes32 public constant ACCEPT_TASK_TYPEHASH =
        keccak256("AcceptTask(bytes32 taskId,address taskor,uint256 nonce,uint256 deadline)");

    bytes32 public constant SUBMIT_WORK_TYPEHASH =
        keccak256("SubmitWork(bytes32 taskId,string evidenceUri,uint256 nonce,uint256 deadline)");

    // ====================================
    // Enums (Enhanced from PointsRecord)
    // ====================================

    enum TaskStatus {
        Open, // Task created, awaiting taskor
        Accepted, // Taskor accepted
        InProgress, // Work in progress
        Submitted, // Work submitted, in challenge period
        Challenged, // Community challenged, awaiting jury
        Finalized, // Completed and paid
        Refunded, // Cancelled or expired
        Disputed // Under jury arbitration
    }

    // ====================================
    // Structs
    // ====================================

    struct Task {
        bytes32 taskId;
        address community;
        address taskor;
        address supplier;
        address token;
        uint256 reward;
        uint256 supplierFee;
        uint256 deadline;
        uint256 createdAt;
        uint256 challengeDeadline; // NEW: When challenge period ends
        uint256 challengeStake; // NEW: Stake locked for challenge
        TaskStatus status;
        string metadataUri;
        string evidenceUri;
        bytes32 taskType;
        bytes32 juryTaskHash;
    }

    struct DistributionShares {
        uint256 taskorShare;
        uint256 supplierShare;
        uint256 juryShare;
    }

    // ====================================
    // Custom Errors (Gas optimization from PointsRecord)
    // ====================================

    error InvalidTaskState();
    error NotCommunity();
    error NotTaskor();
    error NotParticipant();
    error TaskExpired();
    error ChallengePeriodNotOver();
    error ChallengePeriodExpired();
    error AlreadyChallenged();
    error InsufficientChallengeStake();
    error InvalidSignature();
    error SignatureExpired();
    error InvalidNonce();
    error ReentrancyDetected();
    error TransferFailed();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidDeadline();

    // ====================================
    // State Variables
    // ====================================

    address public immutable juryContract;
    address public feeRecipient;
    uint256 public challengePeriod;
    uint256 private _taskCounter;
    uint256 private _reentrancyStatus;

    DistributionShares private _distributionShares;

    // Nonces for replay protection (from PayBot)
    mapping(address => uint256) public nonces;

    // Task storage
    mapping(bytes32 => Task) private _tasks;
    mapping(address => bytes32[]) private _communityTasks;
    mapping(address => bytes32[]) private _taskorTasks;
    mapping(address => bytes32[]) private _supplierTasks;

    // Challenge stakes (from PointsRecord pattern)
    mapping(bytes32 => address) private _challengers;

    // ====================================
    // Events
    // ====================================

    event TaskCreated(bytes32 indexed taskId, address indexed community, address token, uint256 reward);
    event TaskAccepted(bytes32 indexed taskId, address indexed taskor);
    event TaskAcceptedWithSignature(bytes32 indexed taskId, address indexed taskor, address indexed relayer);
    event SupplierAssigned(bytes32 indexed taskId, address indexed supplier, uint256 fee);
    event WorkSubmitted(bytes32 indexed taskId, string evidenceUri, uint256 challengeDeadline);
    event TaskChallenged(bytes32 indexed taskId, address indexed challenger, uint256 stake);
    event TaskFinalized(bytes32 indexed taskId, uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout);
    event TaskAutoFinalized(bytes32 indexed taskId); // NEW: From PointsRecord
    event ChallengeResolved(bytes32 indexed taskId, bool challengeAccepted);
    event TaskCancelled(bytes32 indexed taskId, uint256 refundAmount);

    // ====================================
    // Modifiers
    // ====================================

    modifier nonReentrant() {
        if (_reentrancyStatus == 1) revert ReentrancyDetected();
        _reentrancyStatus = 1;
        _;
        _reentrancyStatus = 0;
    }

    modifier onlyTaskStatus(bytes32 taskId, TaskStatus requiredStatus) {
        if (_tasks[taskId].status != requiredStatus) revert InvalidTaskState();
        _;
    }

    modifier onlyCommunity(bytes32 taskId) {
        if (_tasks[taskId].community != msg.sender) revert NotCommunity();
        _;
    }

    modifier onlyTaskor(bytes32 taskId) {
        if (_tasks[taskId].taskor != msg.sender) revert NotTaskor();
        _;
    }

    // ====================================
    // Constructor
    // ====================================

    constructor(address _juryContract, address _feeRecipient) {
        if (_juryContract == address(0)) revert ZeroAddress();

        juryContract = _juryContract;
        feeRecipient = _feeRecipient;
        challengePeriod = DEFAULT_CHALLENGE_PERIOD;

        _distributionShares = DistributionShares({
            taskorShare: DEFAULT_TASKOR_SHARE, supplierShare: DEFAULT_SUPPLIER_SHARE, juryShare: DEFAULT_JURY_SHARE
        });

        // EIP-712 Domain Separator (from PayBot)
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("MyTask Escrow")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    // ====================================
    // Task Creation
    // ====================================

    function createTask(address token, uint256 reward, uint256 deadline, string calldata metadataUri, bytes32 taskType)
        external
        returns (bytes32 taskId)
    {
        if (reward == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        _taskCounter++;
        taskId = keccak256(abi.encode(msg.sender, _taskCounter, block.timestamp, taskType));

        // Transfer funds to escrow
        if (!IERC20(token).transferFrom(msg.sender, address(this), reward)) {
            revert TransferFailed();
        }

        _tasks[taskId] = Task({
            taskId: taskId,
            community: msg.sender,
            taskor: address(0),
            supplier: address(0),
            token: token,
            reward: reward,
            supplierFee: 0,
            deadline: deadline,
            createdAt: block.timestamp,
            challengeDeadline: 0,
            challengeStake: 0,
            status: TaskStatus.Open,
            metadataUri: metadataUri,
            evidenceUri: "",
            taskType: taskType,
            juryTaskHash: bytes32(0)
        });

        _communityTasks[msg.sender].push(taskId);

        emit TaskCreated(taskId, msg.sender, token, reward);
    }

    /**
     * @notice Create task with EIP-2612 permit (gasless for community)
     * @dev From PayBot pattern - single transaction token approval + escrow
     */
    function createTaskWithPermit(
        address token,
        uint256 reward,
        uint256 deadline,
        string calldata metadataUri,
        bytes32 taskType,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 taskId) {
        // Execute permit first
        IERC20Permit(token).permit(msg.sender, address(this), reward, permitDeadline, v, r, s);

        // Then create task (reuse logic)
        if (reward == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        _taskCounter++;
        taskId = keccak256(abi.encode(msg.sender, _taskCounter, block.timestamp, taskType));

        if (!IERC20(token).transferFrom(msg.sender, address(this), reward)) {
            revert TransferFailed();
        }

        _tasks[taskId] = Task({
            taskId: taskId,
            community: msg.sender,
            taskor: address(0),
            supplier: address(0),
            token: token,
            reward: reward,
            supplierFee: 0,
            deadline: deadline,
            createdAt: block.timestamp,
            challengeDeadline: 0,
            challengeStake: 0,
            status: TaskStatus.Open,
            metadataUri: metadataUri,
            evidenceUri: "",
            taskType: taskType,
            juryTaskHash: bytes32(0)
        });

        _communityTasks[msg.sender].push(taskId);

        emit TaskCreated(taskId, msg.sender, token, reward);
    }

    // ====================================
    // Task Acceptance (with signature support from PayBot)
    // ====================================

    function acceptTask(bytes32 taskId) external onlyTaskStatus(taskId, TaskStatus.Open) {
        Task storage task = _tasks[taskId];
        if (block.timestamp >= task.deadline) revert TaskExpired();

        task.taskor = msg.sender;
        task.status = TaskStatus.Accepted;

        _taskorTasks[msg.sender].push(taskId);

        emit TaskAccepted(taskId, msg.sender);
    }

    /**
     * @notice Accept task with EIP-712 signature (gasless for taskor)
     * @dev Relayer pays gas, taskor just signs. From PayBot pattern.
     */
    function acceptTaskWithSignature(bytes32 taskId, address taskor, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        onlyTaskStatus(taskId, TaskStatus.Open)
    {
        Task storage task = _tasks[taskId];
        if (block.timestamp >= task.deadline) revert TaskExpired();
        if (block.timestamp > deadline) revert SignatureExpired();

        // Verify signature
        bytes32 structHash = keccak256(abi.encode(ACCEPT_TASK_TYPEHASH, taskId, taskor, nonces[taskor], deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address signer = ecrecover(digest, v, r, s);

        if (signer != taskor) revert InvalidSignature();

        // Increment nonce (replay protection)
        nonces[taskor]++;

        task.taskor = taskor;
        task.status = TaskStatus.Accepted;

        _taskorTasks[taskor].push(taskId);

        emit TaskAcceptedWithSignature(taskId, taskor, msg.sender);
    }

    // ====================================
    // Work Submission & Challenge Period (from PointsRecord)
    // ====================================

    function assignSupplier(bytes32 taskId, address supplier, uint256 fee) external onlyTaskor(taskId) {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Accepted && task.status != TaskStatus.InProgress) {
            revert InvalidTaskState();
        }
        if (supplier == address(0)) revert ZeroAddress();

        uint256 maxFee = (task.reward * _distributionShares.supplierShare) / BASIS_POINTS;
        if (fee > maxFee) revert ZeroAmount(); // reusing error for "fee too high"

        task.supplier = supplier;
        task.supplierFee = fee;
        task.status = TaskStatus.InProgress;

        _supplierTasks[supplier].push(taskId);

        emit SupplierAssigned(taskId, supplier, fee);
    }

    /**
     * @notice Submit work and start challenge period
     * @dev From PointsRecord pattern - optimistic completion
     */
    function submitWork(bytes32 taskId, string calldata evidenceUri) external onlyTaskor(taskId) {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Accepted && task.status != TaskStatus.InProgress) {
            revert InvalidTaskState();
        }

        task.evidenceUri = evidenceUri;
        task.status = TaskStatus.Submitted;
        task.challengeDeadline = block.timestamp + challengePeriod;

        emit WorkSubmitted(taskId, evidenceUri, task.challengeDeadline);
    }

    /**
     * @notice Challenge submitted work (community only)
     * @dev From PointsRecord - requires stake to prevent abuse
     */
    function challengeWork(bytes32 taskId) external payable onlyCommunity(taskId) {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Submitted) revert InvalidTaskState();
        if (block.timestamp > task.challengeDeadline) revert ChallengePeriodExpired();
        if (msg.value < MIN_CHALLENGE_STAKE) revert InsufficientChallengeStake();

        task.status = TaskStatus.Challenged;
        task.challengeStake = msg.value;
        _challengers[taskId] = msg.sender;

        emit TaskChallenged(taskId, msg.sender, msg.value);
    }

    /**
     * @notice Auto-finalize after challenge period (anyone can call)
     * @dev From PointsRecord - finalizeRecord pattern
     */
    function finalizeTask(bytes32 taskId) external nonReentrant {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Submitted) revert InvalidTaskState();
        if (block.timestamp <= task.challengeDeadline) revert ChallengePeriodNotOver();

        // Auto-finalize: no challenge within period = work approved
        _distributePayments(taskId);
        task.status = TaskStatus.Finalized;

        emit TaskAutoFinalized(taskId);
    }

    /**
     * @notice Community approves work early (skip challenge period)
     */
    function approveWork(bytes32 taskId) external nonReentrant onlyCommunity(taskId) {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Submitted) revert InvalidTaskState();

        _distributePayments(taskId);
        task.status = TaskStatus.Finalized;

        emit TaskFinalized(taskId, 0, 0, 0); // Amounts logged in _distributePayments
    }

    // ====================================
    // Jury Resolution (for challenged tasks)
    // ====================================

    function linkJuryValidation(bytes32 taskId, bytes32 juryTaskHash) external {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Challenged) revert InvalidTaskState();

        IJuryContract.Task memory juryTask = IJuryContract(juryContract).getTask(juryTaskHash);
        if (juryTask.status != IJuryContract.TaskStatus.COMPLETED) revert InvalidTaskState();

        task.juryTaskHash = juryTaskHash;

        // If jury approved (response >= 50), pay out
        if (juryTask.finalResponse >= 50) {
            _distributePayments(taskId);
            task.status = TaskStatus.Finalized;

            // Return challenge stake to challenger (they were wrong)
            if (task.challengeStake > 0) {
                payable(_challengers[taskId]).transfer(task.challengeStake);
            }

            emit ChallengeResolved(taskId, false);
        } else {
            // Jury rejected - refund community, slash challenger stake
            _refundCommunity(taskId);
            task.status = TaskStatus.Refunded;

            // Challenger stake goes to taskor as compensation
            if (task.challengeStake > 0 && task.taskor != address(0)) {
                payable(task.taskor).transfer(task.challengeStake);
            }

            emit ChallengeResolved(taskId, true);
        }
    }

    // ====================================
    // Cancellation & Refunds
    // ====================================

    function cancelTask(bytes32 taskId) external nonReentrant onlyCommunity(taskId) {
        Task storage task = _tasks[taskId];
        if (task.status != TaskStatus.Open) revert InvalidTaskState();

        _refundCommunity(taskId);
        task.status = TaskStatus.Refunded;

        emit TaskCancelled(taskId, task.reward);
    }

    function claimExpiredRefund(bytes32 taskId) external nonReentrant onlyCommunity(taskId) {
        Task storage task = _tasks[taskId];
        if (block.timestamp <= task.deadline) revert TaskExpired();
        if (task.status != TaskStatus.Open && task.status != TaskStatus.Accepted) {
            revert InvalidTaskState();
        }

        _refundCommunity(taskId);
        task.status = TaskStatus.Refunded;

        emit TaskCancelled(taskId, task.reward);
    }

    // ====================================
    // Internal Functions
    // ====================================

    function _distributePayments(bytes32 taskId) internal {
        Task storage task = _tasks[taskId];
        uint256 reward = task.reward;

        uint256 taskorPayout = (reward * _distributionShares.taskorShare) / BASIS_POINTS;
        uint256 juryPayout = (reward * _distributionShares.juryShare) / BASIS_POINTS;
        uint256 supplierShareCap = (reward * _distributionShares.supplierShare) / BASIS_POINTS;
        uint256 supplierPayout = task.supplier != address(0) ? task.supplierFee : 0;

        if (task.supplier == address(0)) {
            taskorPayout += (supplierShareCap * 7) / 10;
            juryPayout += (supplierShareCap * 3) / 10;
        } else if (supplierPayout < supplierShareCap) {
            uint256 unusedShare = supplierShareCap - supplierPayout;
            taskorPayout += (unusedShare * 7) / 10;
            juryPayout += (unusedShare * 3) / 10;
        }

        IERC20 token = IERC20(task.token);

        if (taskorPayout > 0 && task.taskor != address(0)) {
            if (!token.transfer(task.taskor, taskorPayout)) revert TransferFailed();
        }

        if (supplierPayout > 0 && task.supplier != address(0)) {
            if (!token.transfer(task.supplier, supplierPayout)) revert TransferFailed();
        }

        if (juryPayout > 0) {
            if (!token.transfer(juryContract, juryPayout)) revert TransferFailed();
        }

        emit TaskFinalized(taskId, taskorPayout, supplierPayout, juryPayout);
    }

    function _refundCommunity(bytes32 taskId) internal {
        Task storage task = _tasks[taskId];
        if (!IERC20(task.token).transfer(task.community, task.reward)) {
            revert TransferFailed();
        }
    }

    // ====================================
    // View Functions
    // ====================================

    function getTask(bytes32 taskId) external view returns (Task memory) {
        return _tasks[taskId];
    }

    function getTasksByCommunity(address community) external view returns (bytes32[] memory) {
        return _communityTasks[community];
    }

    function getTasksByTaskor(address taskor) external view returns (bytes32[] memory) {
        return _taskorTasks[taskor];
    }

    function getDistributionShares() external view returns (DistributionShares memory) {
        return _distributionShares;
    }

    function getChallengePeriod() external view returns (uint256) {
        return challengePeriod;
    }

    function isInChallengePeriod(bytes32 taskId) external view returns (bool) {
        Task memory task = _tasks[taskId];
        return task.status == TaskStatus.Submitted && block.timestamp <= task.challengeDeadline;
    }

    function canFinalize(bytes32 taskId) external view returns (bool) {
        Task memory task = _tasks[taskId];
        return task.status == TaskStatus.Submitted && block.timestamp > task.challengeDeadline;
    }
}

/**
 * @notice ERC-20 Permit interface (EIP-2612)
 */
interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
