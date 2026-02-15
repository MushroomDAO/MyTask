// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

import {IJuryContract} from "./interfaces/IJuryContract.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";

interface IMySBT {
    function ownerOf(uint256 tokenId) external view returns (address);
    function isRevoked(uint256 tokenId) external view returns (bool);
}

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

    uint256 public constant DEFAULT_REQUEST_DEADLINE_WINDOW = 7 days;
    uint256 public constant DEFAULT_REQUEST_MIN_JURORS = 3;

    /// @notice Task counter for unique IDs
    uint256 private _taskCounter;

    address public admin;
    bytes32 public constant ROLE_JUROR = keccak256("ROLE_JUROR");
    bytes32 public constant ROLE_VALIDATION_REQUESTER = keccak256("ROLE_VALIDATION_REQUESTER");
    bool public requireJurorRole;
    bool public requireValidationRequesterRole;
    bool public requireNonZeroValidationRequestHash;
    bool public paused;

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

    mapping(bytes32 => bytes32[]) private _validationReceipts;
    mapping(bytes32 => mapping(bytes32 => bool)) private _validationReceiptAdded;

    mapping(bytes32 => bytes32) private _tagRoles;
    mapping(bytes32 => mapping(address => bool)) private _roles;

    struct ValidationStatus {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 tag;
        uint256 lastUpdate;
    }

    event ValidationReceiptLinked(
        bytes32 indexed requestHash, bytes32 indexed receiptId, string receiptUri, address indexed linker
    );

    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event Paused(bool paused);
    event RoleGranted(bytes32 indexed role, address indexed account);
    event RoleRevoked(bytes32 indexed role, address indexed account);
    event TagRoleSet(bytes32 indexed tag, bytes32 indexed role);

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
        admin = msg.sender;
        requireNonZeroValidationRequestHash = true;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Not admin");
        _;
    }

    modifier notPaused() {
        require(!paused, "Paused");
        _;
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "Invalid admin");
        emit AdminUpdated(admin, newAdmin);
        admin = newAdmin;
    }

    function setPaused(bool paused_) external onlyAdmin {
        paused = paused_;
        emit Paused(paused_);
    }

    function setRequireJurorRole(bool enabled) external onlyAdmin {
        requireJurorRole = enabled;
    }

    function setRequireValidationRequesterRole(bool enabled) external onlyAdmin {
        requireValidationRequesterRole = enabled;
    }

    function setRequireNonZeroValidationRequestHash(bool enabled) external onlyAdmin {
        requireNonZeroValidationRequestHash = enabled;
    }

    function grantRole(bytes32 role, address account) external onlyAdmin {
        _roles[role][account] = true;
        emit RoleGranted(role, account);
    }

    function revokeRole(bytes32 role, address account) external onlyAdmin {
        _roles[role][account] = false;
        emit RoleRevoked(role, account);
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _roles[role][account];
    }

    function setTagRole(bytes32 tag, bytes32 role) external onlyAdmin {
        _tagRoles[tag] = role;
        emit TagRoleSet(tag, role);
    }

    function getTagRole(bytes32 tag) external view returns (bytes32) {
        return _tagRoles[tag];
    }

    // ====================================
    // Task Management
    // ====================================

    /// @inheritdoc IJuryContract
    function createTask(TaskParams calldata params) external payable notPaused returns (bytes32 taskHash) {
        require(params.deadline > block.timestamp, "Invalid deadline");
        require(params.minJurors > 0, "Min jurors must be > 0");
        require(params.consensusThreshold <= 10000, "Invalid threshold");
        if (mySBT.code.length > 0) {
            require(_agentIdIsActive(params.agentId), "Invalid agentId");
        }

        _taskCounter++;
        taskHash = keccak256(abi.encode(msg.sender, _taskCounter, params.agentId, params.taskType));

        _initTask(
            taskHash,
            msg.sender,
            params.agentId,
            params.taskType,
            params.evidenceUri,
            params.reward,
            params.deadline,
            params.minJurors,
            params.consensusThreshold
        );

        emit TaskCreated(taskHash, params.agentId, params.taskType, params.reward, params.deadline);

        return taskHash;
    }

    function _initTask(
        bytes32 taskHash,
        address creator,
        uint256 agentId,
        TaskType taskType,
        string memory evidenceUri,
        uint256 reward,
        uint256 deadline,
        uint256 minJurors,
        uint256 consensusThreshold
    ) internal {
        require(_tasks[taskHash].taskHash == bytes32(0), "Task exists");

        _tasks[taskHash] = Task({
            agentId: agentId,
            taskHash: taskHash,
            evidenceUri: evidenceUri,
            taskType: taskType,
            reward: reward,
            deadline: deadline,
            status: TaskStatus.PENDING,
            minJurors: minJurors,
            consensusThreshold: consensusThreshold == 0 ? DEFAULT_CONSENSUS : consensusThreshold,
            totalVotes: 0,
            positiveVotes: 0,
            finalResponse: 0
        });

        _taskCreators[taskHash] = creator;
        _agentValidations[agentId].push(taskHash);
    }

    /// @inheritdoc IJuryContract
    function submitEvidence(bytes32 taskHash, string calldata evidenceUri) external notPaused {
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
    function vote(bytes32 taskHash, uint8 response, string calldata reasoning) external notPaused {
        require(_jurorActive[msg.sender], "Not an active juror");
        require(!_hasVoted[taskHash][msg.sender], "Already voted");

        Task storage task = _tasks[taskHash];
        require(task.taskHash != bytes32(0), "Task not found");
        require(_taskCreators[taskHash] != msg.sender, "Conflict of interest");
        if (mySBT.code.length > 0) {
            try IMySBT(mySBT).ownerOf(task.agentId) returns (address owner) {
                require(owner != msg.sender, "Conflict of interest");
            } catch {}
        }
        require(task.status == TaskStatus.IN_PROGRESS, "Task not in progress");
        require(block.timestamp <= task.deadline, "Voting period ended");
        require(response <= 100, "Invalid response score");

        _hasVoted[taskHash][msg.sender] = true;
        _jurorVoteIndex[taskHash][msg.sender] = _taskVotes[taskHash].length;

        _taskVotes[taskHash].push(
            Vote({
                juror: msg.sender, response: response, reasoning: reasoning, timestamp: block.timestamp, slashed: false
            })
        );

        task.totalVotes++;
        if (response >= 50) {
            task.positiveVotes++;
        }

        emit JurorVoted(taskHash, msg.sender, response, block.timestamp);
    }

    /// @inheritdoc IJuryContract
    function finalizeTask(bytes32 taskHash) external notPaused {
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
        bytes32 validationTag = bytes32(uint256(uint8(task.taskType) + 1));
        _validationStatuses[taskHash] = ValidationStatus({
            validatorAddress: address(this),
            agentId: task.agentId,
            response: task.finalResponse,
            tag: validationTag,
            lastUpdate: block.timestamp
        });

        emit ValidationResponse(address(this), task.agentId, taskHash, task.finalResponse, "", validationTag);
        emit TaskFinalized(taskHash, task.finalResponse, task.totalVotes, task.positiveVotes);
    }

    /// @inheritdoc IJuryContract
    function cancelTask(bytes32 taskHash) external notPaused {
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
    function registerJuror(uint256 stakeAmount) external notPaused {
        require(stakeAmount >= minJurorStake, "Stake too low");
        require(!_jurorActive[msg.sender], "Already registered");
        if (requireJurorRole) {
            require(_roles[ROLE_JUROR][msg.sender], "Missing role");
        }

        // Transfer stake
        require(IERC20(stakingToken).transferFrom(msg.sender, address(this), stakeAmount), "Stake transfer failed");

        _jurorStakes[msg.sender] = stakeAmount;
        _jurorActive[msg.sender] = true;

        emit JurorRegistered(msg.sender, stakeAmount);
    }

    /// @inheritdoc IJuryContract
    function unregisterJuror() external notPaused {
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
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestUri,
        bytes32 requestHash
    ) external notPaused {
        require(validatorAddress == address(this), "Unsupported validator");
        if (requireValidationRequesterRole) {
            require(_roles[ROLE_VALIDATION_REQUESTER][msg.sender], "Missing role");
        }
        if (mySBT.code.length > 0) {
            require(_agentIdIsActive(agentId), "Invalid agentId");
        }
        if (requireNonZeroValidationRequestHash) {
            require(requestHash != bytes32(0), "requestHash required");
        }

        bytes32 taskHash = requestHash != bytes32(0)
            ? requestHash
            : keccak256(abi.encode(msg.sender, agentId, block.timestamp, requestUri));

        _initTask(
            taskHash,
            msg.sender,
            agentId,
            TaskType.CONSENSUS_REQUIRED,
            requestUri,
            0,
            block.timestamp + DEFAULT_REQUEST_DEADLINE_WINDOW,
            DEFAULT_REQUEST_MIN_JURORS,
            DEFAULT_CONSENSUS
        );

        _validatorRequests[validatorAddress].push(taskHash);

        emit ValidationRequest(validatorAddress, agentId, requestUri, taskHash);
    }

    function deriveValidationRequestHash(
        bytes32 taskId,
        uint256 agentId,
        address validatorAddress,
        bytes32 tag,
        string calldata requestUri
    ) external view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, taskId, agentId, validatorAddress, tag, requestUri));
    }

    /// @notice Submit validation response (ERC-8004)
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseUri,
        bytes32, /* responseHash */
        bytes32 tag
    ) external notPaused {
        require(_jurorActive[msg.sender], "Not an active juror");
        require(response <= 100, "Invalid response score");
        Task storage task = _tasks[requestHash];
        require(task.taskHash != bytes32(0), "Task not found");
        require(_taskCreators[requestHash] != msg.sender, "Conflict of interest");
        if (mySBT.code.length > 0) {
            try IMySBT(mySBT).ownerOf(task.agentId) returns (address owner) {
                require(owner != msg.sender, "Conflict of interest");
            } catch {}
        }

        bytes32 requiredRole = _tagRoles[tag];
        if (requiredRole != bytes32(0)) {
            require(_roles[requiredRole][msg.sender], "Missing role");
        }

        _validationStatuses[requestHash] = ValidationStatus({
            validatorAddress: msg.sender,
            agentId: task.agentId,
            response: response,
            tag: tag,
            lastUpdate: block.timestamp
        });

        emit ValidationResponse(msg.sender, task.agentId, requestHash, response, responseUri, tag);
    }

    function _agentIdIsActive(uint256 agentId) internal view returns (bool) {
        try IMySBT(mySBT).ownerOf(agentId) returns (address owner) {
            if (owner == address(0)) return false;
            try IMySBT(mySBT).isRevoked(agentId) returns (bool revoked) {
                if (revoked) return false;
            } catch {}
            return true;
        } catch {
            return false;
        }
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
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, bytes32 tag)
        external
        view
        returns (uint64 count, uint8 avgResponse)
    {
        bytes32[] memory validations = _agentValidations[agentId];
        if (validations.length == 0) return (0, 0);

        uint256 totalResponse = 0;
        uint64 validCount = 0;

        for (uint256 i = 0; i < validations.length; i++) {
            bytes32 requestHash = validations[i];
            Task storage task = _tasks[requestHash];
            if (task.status != TaskStatus.COMPLETED) continue;

            ValidationStatus storage status = _validationStatuses[requestHash];
            if (status.lastUpdate == 0) continue;
            if (tag != bytes32(0) && status.tag != tag) continue;
            if (!_validatorAllowed(status.validatorAddress, validatorAddresses)) continue;

            totalResponse += status.response;
            validCount++;
        }

        return (validCount, validCount > 0 ? uint8(totalResponse / validCount) : 0);
    }

    function _validatorAllowed(address validator, address[] calldata validatorAddresses) internal pure returns (bool) {
        if (validatorAddresses.length == 0) return true;
        for (uint256 i = 0; i < validatorAddresses.length; i++) {
            if (validatorAddresses[i] == validator) return true;
        }
        return false;
    }

    function linkReceiptToValidation(bytes32 requestHash, bytes32 receiptId, string calldata receiptUri)
        external
        notPaused
    {
        require(_taskCreators[requestHash] == msg.sender, "Not task creator");
        require(receiptId != bytes32(0), "Invalid receipt");

        if (_validationReceiptAdded[requestHash][receiptId]) return;
        _validationReceiptAdded[requestHash][receiptId] = true;
        _validationReceipts[requestHash].push(receiptId);

        emit ValidationReceiptLinked(requestHash, receiptId, receiptUri, msg.sender);
    }

    function getValidationReceipts(bytes32 requestHash) external view returns (bytes32[] memory receiptIds) {
        return _validationReceipts[requestHash];
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
