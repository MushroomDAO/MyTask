// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {ITaskEscrow} from "./interfaces/ITaskEscrow.sol";
import {IJuryContract} from "./interfaces/IJuryContract.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/**
 * @title TaskEscrow
 * @notice Four-party task escrow with gasless payment support
 * @dev Implements the MyTask economic model:
 *      - Sponsor creates and funds tasks
 *      - Taskor executes tasks (70% reward)
 *      - Supplier provides resources (20% reward)
 *      - Jury validates completion (10% reward)
 *
 * Features:
 * - EIP-2612 permit for gasless task creation
 * - Integration with JuryContract for validation
 * - Configurable distribution shares
 * - Dispute resolution support
 *
 * @custom:security-contact security@aastar.io
 */
contract TaskEscrow is ITaskEscrow {
    // ====================================
    // Constants
    // ====================================

    uint256 public constant BASIS_POINTS = 10000;
    uint256 public constant DEFAULT_TASKOR_SHARE = 7000;   // 70%
    uint256 public constant DEFAULT_SUPPLIER_SHARE = 2000; // 20%
    uint256 public constant DEFAULT_JURY_SHARE = 1000;     // 10%

    // ====================================
    // State Variables
    // ====================================

    /// @notice JuryContract for task validation
    address public immutable juryContract;

    /// @notice Protocol fee recipient
    address public feeRecipient;

    /// @notice Protocol fee in basis points (default: 0)
    uint256 public protocolFeeBps;

    /// @notice Task counter for unique IDs
    uint256 private _taskCounter;

    /// @notice Distribution shares configuration
    DistributionShares private _distributionShares;

    // ====================================
    // Mappings
    // ====================================

    /// @notice Task data by ID
    mapping(bytes32 => TaskData) private _tasks;

    /// @notice Tasks by sponsor
    mapping(address => bytes32[]) private _sponsorTasks;

    /// @notice Tasks by taskor
    mapping(address => bytes32[]) private _taskorTasks;

    /// @notice Tasks by supplier
    mapping(address => bytes32[]) private _supplierTasks;

    /// @notice Supported payment tokens
    mapping(address => bool) public supportedTokens;

    // ====================================
    // Modifiers
    // ====================================

    modifier onlyTaskState(bytes32 taskId, TaskState requiredState) {
        require(_tasks[taskId].state == requiredState, "Invalid task state");
        _;
    }

    modifier onlySponsor(bytes32 taskId) {
        require(_tasks[taskId].sponsor == msg.sender, "Not sponsor");
        _;
    }

    modifier onlyTaskor(bytes32 taskId) {
        require(_tasks[taskId].taskor == msg.sender, "Not taskor");
        _;
    }

    // ====================================
    // Constructor
    // ====================================

    /**
     * @notice Initialize TaskEscrow
     * @param _juryContract JuryContract address
     * @param _feeRecipient Protocol fee recipient
     */
    constructor(address _juryContract, address _feeRecipient) {
        require(_juryContract != address(0), "Invalid jury contract");

        juryContract = _juryContract;
        feeRecipient = _feeRecipient;

        _distributionShares = DistributionShares({
            taskorShare: DEFAULT_TASKOR_SHARE,
            supplierShare: DEFAULT_SUPPLIER_SHARE,
            juryShare: DEFAULT_JURY_SHARE
        });
    }

    // ====================================
    // Task Lifecycle
    // ====================================

    /// @inheritdoc ITaskEscrow
    function createTask(CreateTaskParams calldata params) external returns (bytes32 taskId) {
        return _createTask(params, msg.sender);
    }

    /// @inheritdoc ITaskEscrow
    function createTaskWithPermit(
        CreateTaskParams calldata params,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 taskId) {
        // Execute permit
        IERC20Permit(params.token).permit(msg.sender, address(this), params.reward, deadline, v, r, s);

        return _createTask(params, msg.sender);
    }

    /**
     * @dev Internal task creation logic
     */
    function _createTask(CreateTaskParams calldata params, address sponsor) internal returns (bytes32 taskId) {
        require(params.reward > 0, "Reward must be > 0");
        require(params.deadline > block.timestamp, "Invalid deadline");
        require(params.minJurors > 0, "Min jurors must be > 0");

        // Generate unique task ID
        _taskCounter++;
        taskId = keccak256(abi.encode(sponsor, _taskCounter, block.timestamp, params.taskType));

        // Transfer funds to escrow
        require(
            IERC20(params.token).transferFrom(sponsor, address(this), params.reward),
            "Transfer failed"
        );

        // Create task
        _tasks[taskId] = TaskData({
            taskId: taskId,
            sponsor: sponsor,
            taskor: address(0),
            supplier: address(0),
            token: params.token,
            reward: params.reward,
            supplierFee: 0,
            deadline: params.deadline,
            createdAt: block.timestamp,
            state: TaskState.CREATED,
            metadataUri: params.metadataUri,
            evidenceUri: "",
            taskType: params.taskType,
            minJurors: params.minJurors,
            juryTaskHash: bytes32(0)
        });

        _sponsorTasks[sponsor].push(taskId);

        emit TaskCreated(taskId, sponsor, params.token, params.reward, params.deadline);

        return taskId;
    }

    /// @inheritdoc ITaskEscrow
    function acceptTask(bytes32 taskId) external onlyTaskState(taskId, TaskState.CREATED) {
        TaskData storage task = _tasks[taskId];
        require(block.timestamp < task.deadline, "Task expired");

        task.taskor = msg.sender;
        task.state = TaskState.ACCEPTED;

        _taskorTasks[msg.sender].push(taskId);

        emit TaskAccepted(taskId, msg.sender, block.timestamp);
    }

    /// @inheritdoc ITaskEscrow
    function assignSupplier(bytes32 taskId, address supplier, uint256 fee) external onlyTaskor(taskId) {
        TaskData storage task = _tasks[taskId];
        require(
            task.state == TaskState.ACCEPTED || task.state == TaskState.IN_PROGRESS,
            "Invalid state"
        );
        require(supplier != address(0), "Invalid supplier");

        // Supplier fee cannot exceed supplier share
        uint256 maxSupplierFee = (task.reward * _distributionShares.supplierShare) / BASIS_POINTS;
        require(fee <= maxSupplierFee, "Fee exceeds max");

        task.supplier = supplier;
        task.supplierFee = fee;
        task.state = TaskState.IN_PROGRESS;

        _supplierTasks[supplier].push(taskId);

        emit SupplierAssigned(taskId, supplier, fee);
    }

    /// @inheritdoc ITaskEscrow
    function submitEvidence(bytes32 taskId, string calldata evidenceUri) external onlyTaskor(taskId) {
        TaskData storage task = _tasks[taskId];
        require(
            task.state == TaskState.ACCEPTED || task.state == TaskState.IN_PROGRESS,
            "Invalid state"
        );
        require(bytes(evidenceUri).length > 0, "Empty evidence");

        task.evidenceUri = evidenceUri;
        task.state = TaskState.SUBMITTED;

        emit EvidenceSubmitted(taskId, evidenceUri, block.timestamp);
    }

    /// @inheritdoc ITaskEscrow
    function linkJuryValidation(bytes32 taskId, bytes32 juryTaskHash) external {
        TaskData storage task = _tasks[taskId];
        require(task.state == TaskState.SUBMITTED, "Not submitted");

        // Verify jury task exists and is completed
        IJuryContract.Task memory juryTask = IJuryContract(juryContract).getTask(juryTaskHash);
        require(juryTask.taskHash == juryTaskHash, "Jury task not found");
        require(
            juryTask.status == IJuryContract.TaskStatus.COMPLETED,
            "Jury validation not complete"
        );

        task.juryTaskHash = juryTaskHash;
        task.state = TaskState.VALIDATED;

        emit TaskValidated(taskId, juryTaskHash, juryTask.finalResponse);
    }

    /// @inheritdoc ITaskEscrow
    function completeTask(bytes32 taskId) external onlyTaskState(taskId, TaskState.VALIDATED) {
        TaskData storage task = _tasks[taskId];

        // Calculate payouts
        (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout) = calculatePayouts(taskId);

        // Update state first (reentrancy protection)
        task.state = TaskState.COMPLETED;

        // Distribute funds
        IERC20 token = IERC20(task.token);

        if (taskorPayout > 0 && task.taskor != address(0)) {
            require(token.transfer(task.taskor, taskorPayout), "Taskor transfer failed");
            emit FundsDistributed(taskId, task.taskor, taskorPayout);
        }

        if (supplierPayout > 0 && task.supplier != address(0)) {
            require(token.transfer(task.supplier, supplierPayout), "Supplier transfer failed");
            emit FundsDistributed(taskId, task.supplier, supplierPayout);
        }

        if (juryPayout > 0) {
            // Send jury share to JuryContract for distribution
            require(token.transfer(juryContract, juryPayout), "Jury transfer failed");
            emit FundsDistributed(taskId, juryContract, juryPayout);
        }

        emit TaskCompleted(taskId, taskorPayout, supplierPayout, juryPayout);
    }

    /// @inheritdoc ITaskEscrow
    function raiseDispute(bytes32 taskId, string calldata reason) external {
        TaskData storage task = _tasks[taskId];
        require(
            msg.sender == task.sponsor ||
            msg.sender == task.taskor ||
            msg.sender == task.supplier,
            "Not participant"
        );
        require(
            task.state == TaskState.IN_PROGRESS ||
            task.state == TaskState.SUBMITTED ||
            task.state == TaskState.VALIDATED,
            "Cannot dispute"
        );

        task.state = TaskState.DISPUTED;

        emit TaskDisputed(taskId, msg.sender, reason);
    }

    /// @inheritdoc ITaskEscrow
    function cancelTask(bytes32 taskId) external onlySponsor(taskId) onlyTaskState(taskId, TaskState.CREATED) {
        TaskData storage task = _tasks[taskId];

        uint256 refundAmount = task.reward;
        task.state = TaskState.CANCELLED;

        // Refund sponsor
        require(
            IERC20(task.token).transfer(task.sponsor, refundAmount),
            "Refund failed"
        );

        emit TaskCancelled(taskId, refundAmount);
    }

    /// @inheritdoc ITaskEscrow
    function claimExpiredRefund(bytes32 taskId) external onlySponsor(taskId) {
        TaskData storage task = _tasks[taskId];
        require(block.timestamp > task.deadline, "Not expired");
        require(
            task.state == TaskState.CREATED ||
            task.state == TaskState.ACCEPTED,
            "Cannot refund"
        );

        uint256 refundAmount = task.reward;
        task.state = TaskState.EXPIRED;

        require(
            IERC20(task.token).transfer(task.sponsor, refundAmount),
            "Refund failed"
        );

        emit TaskCancelled(taskId, refundAmount);
    }

    // ====================================
    // View Functions
    // ====================================

    /// @inheritdoc ITaskEscrow
    function getTask(bytes32 taskId) external view returns (TaskData memory task) {
        return _tasks[taskId];
    }

    /// @inheritdoc ITaskEscrow
    function getTasksBySponsor(address sponsor) external view returns (bytes32[] memory taskIds) {
        return _sponsorTasks[sponsor];
    }

    /// @inheritdoc ITaskEscrow
    function getTasksByTaskor(address taskor) external view returns (bytes32[] memory taskIds) {
        return _taskorTasks[taskor];
    }

    /// @inheritdoc ITaskEscrow
    function getDistributionShares() external view returns (DistributionShares memory shares) {
        return _distributionShares;
    }

    /// @inheritdoc ITaskEscrow
    function getJuryContract() external view returns (address jury) {
        return juryContract;
    }

    /// @inheritdoc ITaskEscrow
    function calculatePayouts(bytes32 taskId)
        public
        view
        returns (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout)
    {
        TaskData memory task = _tasks[taskId];
        uint256 reward = task.reward;

        // Calculate shares
        taskorPayout = (reward * _distributionShares.taskorShare) / BASIS_POINTS;
        juryPayout = (reward * _distributionShares.juryShare) / BASIS_POINTS;

        // Supplier gets their negotiated fee (up to supplier share)
        if (task.supplier != address(0)) {
            supplierPayout = task.supplierFee;
        } else {
            // No supplier - split supplier share between taskor and jury
            uint256 unusedSupplierShare = (reward * _distributionShares.supplierShare) / BASIS_POINTS;
            taskorPayout += (unusedSupplierShare * 7) / 10; // 70% to taskor
            juryPayout += (unusedSupplierShare * 3) / 10;   // 30% to jury
        }

        return (taskorPayout, supplierPayout, juryPayout);
    }

    // ====================================
    // Admin Functions
    // ====================================

    /**
     * @notice Update distribution shares
     * @param taskorShare New taskor share in basis points
     * @param supplierShare New supplier share in basis points
     * @param juryShare New jury share in basis points
     */
    function setDistributionShares(
        uint256 taskorShare,
        uint256 supplierShare,
        uint256 juryShare
    ) external {
        require(msg.sender == feeRecipient, "Not authorized");
        require(taskorShare + supplierShare + juryShare == BASIS_POINTS, "Must sum to 10000");

        _distributionShares = DistributionShares({
            taskorShare: taskorShare,
            supplierShare: supplierShare,
            juryShare: juryShare
        });
    }

    /**
     * @notice Add supported token
     * @param token Token address to support
     */
    function addSupportedToken(address token) external {
        require(msg.sender == feeRecipient, "Not authorized");
        supportedTokens[token] = true;
    }
}

/**
 * @notice ERC-20 Permit interface (EIP-2612)
 */
interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}
