// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/**
 * @title IERC8004ValidationRegistry
 * @notice ERC-8004 Validation Registry interface for task verification
 * @dev Standard interface from ERC-8004 (Trustless Agents)
 */
interface IERC8004ValidationRegistry {
    // ====================================
    // Events
    // ====================================

    /// @notice Emitted when validation is requested
    event ValidationRequest(
        address indexed validatorAddress, uint256 indexed agentId, string requestUri, bytes32 indexed requestHash
    );

    /// @notice Emitted when validation response is submitted
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseUri,
        bytes32 tag
    );

    // ====================================
    // Write Functions
    // ====================================

    /**
     * @notice Request validation from a validator
     * @param validatorAddress Validator to request from
     * @param agentId Agent requesting validation
     * @param requestUri URI to validation request details
     * @param requestHash Hash of request (optional for IPFS)
     */
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestUri,
        bytes32 requestHash
    ) external;

    /**
     * @notice Submit validation response
     * @param requestHash Hash of original request
     * @param response Validation result (0=failed, 100=passed, 1-99=partial)
     * @param responseUri URI to detailed response
     * @param responseHash Hash of response file
     * @param tag Category tag for validation
     */
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseUri,
        bytes32 responseHash,
        bytes32 tag
    ) external;

    // ====================================
    // Read Functions
    // ====================================

    /**
     * @notice Get validation status
     * @param requestHash Request hash to query
     * @return validatorAddress Assigned validator
     * @return agentId Agent who requested
     * @return response Validation response (0-100)
     * @return tag Validation category
     * @return lastUpdate Last update timestamp
     */
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address validatorAddress, uint256 agentId, uint8 response, bytes32 tag, uint256 lastUpdate);

    /**
     * @notice Get validation summary for agent
     * @param agentId Agent token ID
     * @param validatorAddresses Filter by validators (empty for all)
     * @param tag Filter by category tag
     * @return count Number of validations
     * @return avgResponse Average response score
     */
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, bytes32 tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);

    /**
     * @notice Get all validation request hashes for agent
     * @param agentId Agent token ID
     * @return requestHashes Array of request hashes
     */
    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory requestHashes);

    /**
     * @notice Get all request hashes assigned to validator
     * @param validatorAddress Validator address
     * @return requestHashes Array of request hashes
     */
    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory requestHashes);
}
