// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

/// @title ITaskCallback
/// @notice Callback interface for contracts that want to be notified when a JuryContract task is finalized
/// @dev Implement this interface in contracts that need automatic notification (e.g., DisputeEscrow)
interface ITaskCallback {
    /// @notice Called by JuryContract when a task is finalized
    /// @param taskHash   The unique task identifier
    /// @param finalScore The average vote score (0-100)
    /// @param reached    Whether consensus threshold was reached (true = COMPLETED, false = DISPUTED)
    function onTaskFinalized(
        bytes32 taskHash,
        uint8 finalScore,
        bool reached
    ) external;
}
