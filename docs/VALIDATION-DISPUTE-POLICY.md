## Validation dispute triggers (soft → hard)

This policy maps ERC-8004 validations into operational or onchain dispute actions.

### Inputs

- TaskEscrowV2 per-task requirements: required tags, minimum count, minimum average response, minimum unique validators.
- JuryContract per-request status: validatorAddress, response (0–100), tag, lastUpdate.
- Receipts linked to tasks and validations.

### Soft dispute triggers (reputation-only)

- Missing validations: task has at least one enabled requirement but validations are not satisfied after the challenge deadline.
- Low score: at least one validation response exists for a required tag but the average is below threshold.
- Single-validator dominance: requirement sets minUniqueValidators but unique validator count is below threshold.
- Receipt mismatch: a receipt is linked but its hash does not match the referenced receiptUri content hash offchain.

### Hard dispute triggers (onchain enforcement candidates)

- Conflicting validations across unique validators for the same tag where the spread exceeds a configured band.
- Evidence/receipt fraud proven offchain with a reproducible proof, and the corresponding receipt is linked onchain.
- Unauthorized tag response: a response is submitted for a tag that is role-gated, without the role (must revert).

### Suggested actions

- Soft dispute: deny auto-finalization, surface warnings in dashboards, and penalize agent reputation.
- Hard dispute: initiate TaskEscrowV2 challenge flow, escalate to jury-based arbitration, and apply slashing rules when implemented.

### Current onchain capabilities in this repo

- Settlement gating by validation thresholds and unique validators.
- Task challenge period and finalize reverts when requirements are not satisfied.
- Role gating of validation responses by tag roles in JuryContract.
