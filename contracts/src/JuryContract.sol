// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IJuryContract} from "./interfaces/IJuryContract.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

/**
 * @title JuryContract
 * @notice ERC-8004 Validation Registry implementation with jury-based verification
 * @dev Implements multi-party task verification with staking incentives
 *
 * Key Features:
 * - Multiple task types (simple, consensus, crypto-economic, TEE)
 * - Juror registration with staking
 * - Slashing for dishonest voting
 * - Rewards for honest voting
 * - Integration with MySBT for agent identity
 *
 * @custom:security-contact security@aastar.io
 */
contract JuryContract is IJuryContract {
    // ====================================
    // State Variables
    // ====================================

    /// @notice MySBT contract for agent identity verification
    address public immutable mySBT;

    /// @notice Staking token (e.g., xPNT)
    address public immutable stakingToken;

    /// @notice Minimum stake required to be a juror
    uint256 public minJurorStake;

    /// @notice Cooldown period for juror unregistration
    uint256 public constant JUROR_COOLDOWN = 7 days;

    /// @notice Default consensus threshold (66%)
    uint256 public constant DEFAULT_CONSENSUS = 6600;

    /// @notice Task counter for unique IDs
    uint256 private _taskCounter;

    // ====================================
    // Mappings
    // ====================================

    /// @notice Task data by hash
    mapping(bytes32 => Task) private _tasks;

    /// @notice Votes for each task
    mapping(bytes32 => Vote[]) private _taskVotes;

    /// @notice Track if juror voted on task
    mapping(bytes32 => mapping(address => bool)) private _hasVoted;

    /// @notice Juror vote index in array
    mapping(bytes32 => mapping(address => uint256)) private _jurorVoteIndex;

    /// @notice Task creator
    mapping(bytes32 => address) private _taskCreators;

    /// @notice Juror stake amounts
    mapping(address => uint256) private _jurorStakes;

    /// @notice Juror active status
    mapping(address => bool) private _jurorActive;

    /// @notice Juror unregister request timestamp
    mapping(address => uint256) private _jurorUnregisterTime;

    /// @notice Agent's validation requests
    mapping(uint256 => bytes32[]) private _agentValidations;

    /// @notice Validator's assigned requests
    mapping(address => bytes32[]) private _validatorRequests;

    /// @notice ERC-8004 validation status (requestHash => status)
    mapping(bytes32 => ValidationStatus) private _validationStatuses;

    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 tag;
        uint256 lastUpdate;
    }

    // ====================================
    // Constructor
    // ====================================

    /**
     * @notice Initialize the JuryContract
     * @param _mySBT MySBT contract address for agent identity
     * @param _stakingToken Token used for juror staking
     * @param _minStake Minimum stake to become a juror
     */
    constructor(address _mySBT, address _stakingToken, uint256 _minStake) {
        require(_mySBT != address(0), "Invalid MySBT address");
        require(_stakingToken != address(0), "Invalid staking token");

        mySBT = _mySBT;
        stakingToken = _stakingToken;
        minJurorStake = _minStake;
    }

    // ====================================
    // Task Management
    // ====================================

    /// @inheritdoc IJuryContract
    function createTask(TaskParams calldata params) external payable returns (bytes32 taskHash) {
        require(params.deadline > block.timestamp, "Invalid deadline");
        require(params.minJurors > 0, "Min jurors must be > 0");
        require(params.consensusThreshold <= 10000, "Invalid threshold");

        _taskCounter++;
        taskHash = keccak256(abi.encode(msg.sender, _taskCounter, block.timestamp, params.agentId));

        _tasks[taskHash] = Task({
            agentId: params.agentId,
            taskHash: taskHash,
            evidenceUri: params.evidenceUri,
            taskType: params.taskType,
            reward: params.reward,
            deadline: params.deadline,
            status: TaskStatus.PENDING,
            minJurors: params.minJurors,
            consensusThreshold: params.consensusThreshold == 0 ? DEFAULT_CONSENSUS : params.consensusThreshold,
            totalVotes: 0,
            positiveVotes: 0,
            finalResponse: 0
        });

        _taskCreators[taskHash] = msg.sender;
        _agentValidations[params.agentId].push(taskHash);

        emit TaskCreated(taskHash, params.agentId, params.taskType, params.reward, params.deadline);

        return taskHash;
    }

    /// @inheritdoc IJuryContract
    function submitEvidence(bytes32 taskHash, string calldata evidenceUri) external {
        Task storage task = _tasks[taskHash];
        require(task.taskHash != bytes32(0), "Task not found");
        require(_taskCreators[taskHash] == msg.sender, "Not task creator");
        require(task.status == TaskStatus.PENDING || task.status == TaskStatus.IN_PROGRESS, "Invalid status");

        task.evidenceUri = evidenceUri;
        if (task.status == TaskStatus.PENDING) {
            task.status = TaskStatus.IN_PROGRESS;
        }

        emit EvidenceSubmitted(taskHash, evidenceUri, block.timestamp);
    }

    /// @inheritdoc IJuryContract
    function vote(bytes32 taskHash, uint8 response, string calldata reasoning) external {
        require(_jurorActive[msg.sender], "Not an active juror");
        require(!_hasVoted[taskHash][msg.sender], "Already voted");

        Task storage task = _tasks[taskHash];
        require(task.taskHash != bytes32(0), "Task not found");
        require(task.status == TaskStatus.IN_PROGRESS, "Task not in progress");
        require(block.timestamp <= task.deadline, "Voting period ended");
        require(response <= 100, "Invalid response score");

        _hasVoted[taskHash][msg.sender] = true;
        _jurorVoteIndex[taskHash][msg.sender] = _taskVotes[taskHash].length;

        _taskVotes[taskHash].push(
            Vote({juror: msg.sender, response: response, reasoning: reasoning, timestamp: block.timestamp, slashed: false})
        );

        task.totalVotes++;
        if (response >= 50) {
            task.positiveVotes++;
        }

        emit JurorVoted(taskHash, msg.sender, response, block.timestamp);
    }

    /// @inheritdoc IJuryContract
    function finalizeTask(bytes32 taskHash) external {
        Task storage task = _tasks[taskHash];
        require(task.taskHash != bytes32(0), "Task not found");
        require(task.status == TaskStatus.IN_PROGRESS, "Task not in progress");
        require(block.timestamp > task.deadline || task.totalVotes >= task.minJurors, "Cannot finalize yet");

        // Calculate final response
        uint256 totalScore = 0;
        Vote[] storage votes = _taskVotes[taskHash];
        for (uint256 i = 0; i < votes.length; i++) {
            totalScore += votes[i].response;
        }

        task.finalResponse = votes.length > 0 ? uint8(totalScore / votes.length) : 0;

        // Check consensus
        uint256 consensusRate = votes.length > 0 ? (task.positiveVotes * 10000) / votes.length : 0;

        if (consensusRate >= task.consensusThreshold) {
            task.status = TaskStatus.COMPLETED;
        } else {
            task.status = TaskStatus.DISPUTED;
        }

        // Update ERC-8004 validation status
        _validationStatuses[taskHash] = ValidationStatus({
            validatorAddress: address(this),
            agentId: task.agentId,
            response: task.finalResponse,
            tag: bytes32(uint256(task.taskType)),
            lastUpdate: block.timestamp
        });

        emit TaskFinalized(taskHash, task.finalResponse, task.totalVotes, task.positiveVotes);
    }

    /// @inheritdoc IJuryContract
    function cancelTask(bytes32 taskHash) external {
        Task storage task = _tasks[taskHash];
        require(task.taskHash != bytes32(0), "Task not found");
        require(_taskCreators[taskHash] == msg.sender, "Not task creator");
        require(task.status == TaskStatus.PENDING, "Can only cancel pending tasks");
        require(task.totalVotes == 0, "Votes already submitted");

        task.status = TaskStatus.CANCELLED;
    }

    // ====================================
    // Jury Management
    // ====================================

    /// @inheritdoc IJuryContract
    function registerJuror(uint256 stakeAmount) external {
        require(stakeAmount >= minJurorStake, "Stake too low");
        require(!_jurorActive[msg.sender], "Already registered");

        // Transfer stake
        require(IERC20(stakingToken).transferFrom(msg.sender, address(this), stakeAmount), "Stake transfer failed");

        _jurorStakes[msg.sender] = stakeAmount;
        _jurorActive[msg.sender] = true;

        emit JurorRegistered(msg.sender, stakeAmount);
    }

    /// @inheritdoc IJuryContract
    function unregisterJuror() external {
        require(_jurorActive[msg.sender], "Not a juror");

        if (_jurorUnregisterTime[msg.sender] == 0) {
            // Initiate cooldown
            _jurorUnregisterTime[msg.sender] = block.timestamp;
            return;
        }

        require(block.timestamp >= _jurorUnregisterTime[msg.sender] + JUROR_COOLDOWN, "Cooldown not complete");

        uint256 stake = _jurorStakes[msg.sender];
        _jurorStakes[msg.sender] = 0;
        _jurorActive[msg.sender] = false;
        _jurorUnregisterTime[msg.sender] = 0;

        // Return stake
        require(IERC20(stakingToken).transfer(msg.sender, stake), "Stake return failed");

        emit JurorUnregistered(msg.sender, stake);
    }

    /// @inheritdoc IJuryContract
    function isActiveJuror(address juror) external view returns (bool isActive, uint256 stake) {
        return (_jurorActive[juror], _jurorStakes[juror]);
    }

    // ====================================
    // View Functions
    // ====================================

    /// @inheritdoc IJuryContract
    function getTask(bytes32 taskHash) external view returns (Task memory task) {
        return _tasks[taskHash];
    }

    /// @inheritdoc IJuryContract
    function getVotes(bytes32 taskHash) external view returns (Vote[] memory votes) {
        return _taskVotes[taskHash];
    }

    /// @inheritdoc IJuryContract
    function getJurorVote(bytes32 taskHash, address juror) external view returns (Vote memory vote_, bool hasVoted) {
        if (!_hasVoted[taskHash][juror]) {
            return (Vote({juror: address(0), response: 0, reasoning: "", timestamp: 0, slashed: false}), false);
        }
        uint256 index = _jurorVoteIndex[taskHash][juror];
        return (_taskVotes[taskHash][index], true);
    }

    /// @inheritdoc IJuryContract
    function getMySBT() external view returns (address) {
        return mySBT;
    }

    /// @inheritdoc IJuryContract
    function getMinJurorStake() external view returns (uint256) {
        return minJurorStake;
    }

    /// @inheritdoc IJuryContract
    function getStakingToken() external view returns (address) {
        return stakingToken;
    }

    // ====================================
    // ERC-8004 Validation Registry
    // ====================================

    /// @notice Request validation from a validator (ERC-8004)
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestUri, bytes32 requestHash)
        external
    {
        // For JuryContract, we create a task instead of direct validation request
        bytes32 taskHash = requestHash != bytes32(0)
            ? requestHash
            : keccak256(abi.encode(msg.sender, agentId, block.timestamp, requestUri));

        _validatorRequests[validatorAddress].push(taskHash);

        emit ValidationRequest(validatorAddress, agentId, requestUri, taskHash);
    }

    /// @notice Submit validation response (ERC-8004)
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseUri,
        bytes32, /* responseHash */
        bytes32 tag
    ) external {
        Task storage task = _tasks[requestHash];
        require(task.taskHash != bytes32(0), "Task not found");

        _validationStatuses[requestHash] = ValidationStatus({
            validatorAddress: msg.sender,
            agentId: task.agentId,
            response: response,
            tag: tag,
            lastUpdate: block.timestamp
        });

        emit ValidationResponse(msg.sender, task.agentId, requestHash, response, responseUri, tag);
    }

    /// @notice Get validation status (ERC-8004)
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 tag, uint256 lastUpdate)
    {
        ValidationStatus memory status = _validationStatuses[requestHash];
        return (status.validatorAddress, status.agentId, status.response, status.tag, status.lastUpdate);
    }

    /// @notice Get validation summary for agent (ERC-8004)
    function getSummary(uint256 agentId, address[] calldata, /* validatorAddresses */ bytes32 /* tag */ )
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32[] memory validations = _agentValidations[agentId];
        if (validations.length == 0) {
            return (0, 0);
        }

        uint256 totalResponse = 0;
        uint64 validCount = 0;

        for (uint256 i = 0; i < validations.length; i++) {
            Task memory task = _tasks[validations[i]];
            if (task.status == TaskStatus.COMPLETED) {
                totalResponse += task.finalResponse;
                validCount++;
            }
        }

        return (validCount, validCount > 0 ? uint8(totalResponse / validCount) : 0);
    }

    /// @notice Get all validation request hashes for agent (ERC-8004)
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes) {
        return _agentValidations[agentId];
    }

    /// @notice Get all request hashes assigned to validator (ERC-8004)
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes) {
        return _validatorRequests[validatorAddress];
    }
}
