// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title ITaskEscrow
 * @notice Interface for the four-party task escrow system
 * @dev Manages fund flow between Sponsor, Taskor, Supplier, and Jury
 *
 * Economic Model:
 * - Sponsor: Creates and funds tasks
 * - Taskor: Executes tasks (receives 70% of reward)
 * - Supplier: Provides resources (receives 20% of reward)
 * - Jury: Validates completion (receives 10% of reward)
 */
interface ITaskEscrow {
    // ====================================
    // Enums
    // ====================================

    /// @notice Task lifecycle states
    enum TaskState {
        CREATED,      // Task created, funds escrowed
        ACCEPTED,     // Taskor accepted the task
        IN_PROGRESS,  // Task execution started
        SUBMITTED,    // Evidence submitted for review
        VALIDATED,    // Jury validated completion
        COMPLETED,    // Funds distributed
        DISPUTED,     // Under dispute resolution
        CANCELLED,    // Task cancelled
        EXPIRED       // Task deadline passed
    }

    // ====================================
    // Structs
    // ====================================

    /// @notice Task creation parameters
    struct CreateTaskParams {
        address token;              // Payment token (ERC-20)
        uint256 reward;             // Total reward amount
        uint256 deadline;           // Task deadline timestamp
        uint256 minJurors;          // Minimum jurors for validation
        string metadataUri;         // IPFS URI for task details
        bytes32 taskType;           // Task category
    }

    /// @notice Full task data
    struct TaskData {
        bytes32 taskId;
        address sponsor;
        address taskor;
        address supplier;
        address token;
        uint256 reward;
        uint256 supplierFee;
        uint256 deadline;
        uint256 createdAt;
        TaskState state;
        string metadataUri;
        string evidenceUri;
        bytes32 taskType;
        uint256 minJurors;
        bytes32 juryTaskHash;       // Reference to JuryContract task
    }

    /// @notice Distribution shares (in basis points, 10000 = 100%)
    struct DistributionShares {
        uint256 taskorShare;        // Default: 7000 (70%)
        uint256 supplierShare;      // Default: 2000 (20%)
        uint256 juryShare;          // Default: 1000 (10%)
    }

    // ====================================
    // Events
    // ====================================

    event TaskCreated(
        bytes32 indexed taskId,
        address indexed sponsor,
        address token,
        uint256 reward,
        uint256 deadline
    );

    event TaskAccepted(
        bytes32 indexed taskId,
        address indexed taskor,
        uint256 timestamp
    );

    event SupplierAssigned(
        bytes32 indexed taskId,
        address indexed supplier,
        uint256 fee
    );

    event EvidenceSubmitted(
        bytes32 indexed taskId,
        string evidenceUri,
        uint256 timestamp
    );

    event TaskValidated(
        bytes32 indexed taskId,
        bytes32 indexed juryTaskHash,
        uint8 response
    );

    event TaskCompleted(
        bytes32 indexed taskId,
        uint256 taskorPayout,
        uint256 supplierPayout,
        uint256 juryPayout
    );

    event TaskDisputed(
        bytes32 indexed taskId,
        address indexed disputant,
        string reason
    );

    event TaskCancelled(
        bytes32 indexed taskId,
        uint256 refundAmount
    );

    event FundsDistributed(
        bytes32 indexed taskId,
        address indexed recipient,
        uint256 amount
    );

    // ====================================
    // Task Lifecycle
    // ====================================

    /**
     * @notice Create a new task with escrowed funds
     * @param params Task creation parameters
     * @return taskId Unique task identifier
     */
    function createTask(CreateTaskParams calldata params) external returns (bytes32 taskId);

    /**
     * @notice Create task with EIP-2612 permit (gasless for sponsor)
     * @param params Task creation parameters
     * @param deadline Permit deadline
     * @param v Signature v
     * @param r Signature r
     * @param s Signature s
     * @return taskId Unique task identifier
     */
    function createTaskWithPermit(
        CreateTaskParams calldata params,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (bytes32 taskId);

    /**
     * @notice Accept a task as taskor
     * @param taskId Task to accept
     */
    function acceptTask(bytes32 taskId) external;

    /**
     * @notice Assign a supplier to the task
     * @param taskId Task ID
     * @param supplier Supplier address
     * @param fee Supplier fee (must be <= supplierShare of reward)
     */
    function assignSupplier(bytes32 taskId, address supplier, uint256 fee) external;

    /**
     * @notice Submit evidence of task completion
     * @param taskId Task ID
     * @param evidenceUri URI to evidence (IPFS)
     */
    function submitEvidence(bytes32 taskId, string calldata evidenceUri) external;

    /**
     * @notice Link jury validation result
     * @param taskId Task ID
     * @param juryTaskHash Hash from JuryContract
     */
    function linkJuryValidation(bytes32 taskId, bytes32 juryTaskHash) external;

    /**
     * @notice Complete task and distribute funds
     * @param taskId Task to complete
     */
    function completeTask(bytes32 taskId) external;

    /**
     * @notice Raise a dispute
     * @param taskId Task ID
     * @param reason Dispute reason
     */
    function raiseDispute(bytes32 taskId, string calldata reason) external;

    /**
     * @notice Cancel task (only before acceptance)
     * @param taskId Task to cancel
     */
    function cancelTask(bytes32 taskId) external;

    /**
     * @notice Claim refund for expired task
     * @param taskId Expired task ID
     */
    function claimExpiredRefund(bytes32 taskId) external;

    // ====================================
    // View Functions
    // ====================================

    /**
     * @notice Get task data
     * @param taskId Task ID
     * @return task Full task data
     */
    function getTask(bytes32 taskId) external view returns (TaskData memory task);

    /**
     * @notice Get tasks by sponsor
     * @param sponsor Sponsor address
     * @return taskIds Array of task IDs
     */
    function getTasksBySponsor(address sponsor) external view returns (bytes32[] memory taskIds);

    /**
     * @notice Get tasks by taskor
     * @param taskor Taskor address
     * @return taskIds Array of task IDs
     */
    function getTasksByTaskor(address taskor) external view returns (bytes32[] memory taskIds);

    /**
     * @notice Get distribution shares
     * @return shares Current distribution configuration
     */
    function getDistributionShares() external view returns (DistributionShares memory shares);

    /**
     * @notice Get JuryContract address
     * @return jury JuryContract address
     */
    function getJuryContract() external view returns (address jury);

    /**
     * @notice Calculate payout amounts for a task
     * @param taskId Task ID
     * @return taskorPayout Amount for taskor
     * @return supplierPayout Amount for supplier
     * @return juryPayout Amount for jury pool
     */
    function calculatePayouts(bytes32 taskId)
        external
        view
        returns (uint256 taskorPayout, uint256 supplierPayout, uint256 juryPayout);
}
