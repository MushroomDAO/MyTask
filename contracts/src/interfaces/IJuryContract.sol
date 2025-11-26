// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import "./IERC8004ValidationRegistry.sol";

/**
 * @title IJuryContract
 * @notice Jury-based validation for ERC-8004 compliance
 * @dev Implements multi-party task verification with staking
 *
 * Integration: References MySBT for agent identity verification
 */
interface IJuryContract is IERC8004ValidationRegistry {
    // ====================================
    // Data Structures
    // ====================================

    /// @notice Task type enumeration
    enum TaskType {
        SIMPLE_VERIFICATION, // Single jury vote
        CONSENSUS_REQUIRED, // Multiple jury agreement
        CRYPTO_ECONOMIC, // Stake-weighted voting
        TEE_ATTESTATION // Trusted execution environment

    }

    /// @notice Task status
    enum TaskStatus {
        PENDING,
        IN_PROGRESS,
        COMPLETED,
        DISPUTED,
        CANCELLED
    }

    /// @notice Task parameters for creation
    struct TaskParams {
        uint256 agentId;
        TaskType taskType;
        string evidenceUri;
        uint256 reward;
        uint256 deadline;
        uint256 minJurors;
        uint256 consensusThreshold; // Basis points (6600 = 66%)

    }

    /// @notice Full task data
    struct Task {
        uint256 agentId;
        bytes32 taskHash;
        string evidenceUri;
        TaskType taskType;
        uint256 reward;
        uint256 deadline;
        TaskStatus status;
        uint256 minJurors;
        uint256 consensusThreshold;
        uint256 totalVotes;
        uint256 positiveVotes;
        uint8 finalResponse;
    }

    /// @notice Juror vote record
    struct Vote {
        address juror;
        uint8 response;
        string reasoning;
        uint256 timestamp;
        bool slashed;
    }

    // ====================================
    // Events
    // ====================================

    event TaskCreated(
        bytes32 indexed taskHash, uint256 indexed agentId, TaskType taskType, uint256 reward, uint256 deadline
    );

    event EvidenceSubmitted(bytes32 indexed taskHash, string evidenceUri, uint256 timestamp);

    event JurorVoted(bytes32 indexed taskHash, address indexed juror, uint8 response, uint256 timestamp);

    event TaskFinalized(bytes32 indexed taskHash, uint8 finalResponse, uint256 totalVotes, uint256 positiveVotes);

    event JurorSlashed(bytes32 indexed taskHash, address indexed juror, uint256 amount);

    event JurorRewarded(bytes32 indexed taskHash, address indexed juror, uint256 amount);

    event JurorRegistered(address indexed juror, uint256 stakeAmount);

    event JurorUnregistered(address indexed juror, uint256 stakeReturned);

    // ====================================
    // Task Management
    // ====================================

    /**
     * @notice Create a new task for validation
     * @param params Task parameters
     * @return taskHash Unique task identifier
     */
    function createTask(TaskParams calldata params) external payable returns (bytes32 taskHash);

    /**
     * @notice Submit evidence for task
     * @param taskHash Task to submit evidence for
     * @param evidenceUri URI to evidence
     */
    function submitEvidence(bytes32 taskHash, string calldata evidenceUri) external;

    /**
     * @notice Vote on task as juror
     * @param taskHash Task to vote on
     * @param response Validation response (0-100)
     * @param reasoning URI to detailed reasoning
     */
    function vote(bytes32 taskHash, uint8 response, string calldata reasoning) external;

    /**
     * @notice Finalize task after voting period
     * @param taskHash Task to finalize
     */
    function finalizeTask(bytes32 taskHash) external;

    /**
     * @notice Cancel task (only creator before votes)
     * @param taskHash Task to cancel
     */
    function cancelTask(bytes32 taskHash) external;

    // ====================================
    // Jury Management
    // ====================================

    /**
     * @notice Register as juror with stake
     * @param stakeAmount Amount to stake
     */
    function registerJuror(uint256 stakeAmount) external;

    /**
     * @notice Unregister juror (with cooldown)
     */
    function unregisterJuror() external;

    /**
     * @notice Check if address is active juror
     * @param juror Address to check
     * @return isActive Whether juror is active
     * @return stake Juror's stake amount
     */
    function isActiveJuror(address juror) external view returns (bool isActive, uint256 stake);

    // ====================================
    // View Functions
    // ====================================

    /**
     * @notice Get task details
     * @param taskHash Task hash
     * @return task Task data
     */
    function getTask(bytes32 taskHash) external view returns (Task memory task);

    /**
     * @notice Get votes for task
     * @param taskHash Task hash
     * @return votes Array of votes
     */
    function getVotes(bytes32 taskHash) external view returns (Vote[] memory votes);

    /**
     * @notice Get juror's vote for task
     * @param taskHash Task hash
     * @param juror Juror address
     * @return vote_ Juror's vote (if exists)
     * @return hasVoted Whether juror has voted
     */
    function getJurorVote(bytes32 taskHash, address juror) external view returns (Vote memory vote_, bool hasVoted);

    // ====================================
    // Configuration
    // ====================================

    /**
     * @notice Get MySBT contract (Identity Registry)
     * @return mysbt MySBT contract address
     */
    function getMySBT() external view returns (address mysbt);

    /**
     * @notice Get minimum juror stake
     * @return minStake Minimum stake amount
     */
    function getMinJurorStake() external view returns (uint256 minStake);

    /**
     * @notice Get staking token
     * @return token Staking token address
     */
    function getStakingToken() external view returns (address token);
}
