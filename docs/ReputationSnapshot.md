# Reputation Snapshot (M1)

The indexer exposes a portable “agent reputation snapshot” that can be copied across environments and verified via a deterministic digest.

## Endpoints

- `GET /reputation`
  - Returns a list of known agents and the per-agent snapshot URL.
- `GET /reputation/:agentId`
  - Returns `{ reputation, canonical, digest }`.

## Response shape

`GET /reputation/:agentId` returns:

- `reputation`: the structured payload (JSON object)
- `canonical`: a deterministic JSON string derived from `reputation`
- `digest`: `keccak256(toHex(canonical))`

`reputation.schema` is `aastar.agentReputation@v1`.

## Verification

To verify a snapshot:

1. Recompute `keccak256(utf8Bytes(canonical))`
2. Compare the result with `digest`

The canonicalization rule is:

- Objects: keys are sorted lexicographically
- Arrays: order is preserved
- Numbers/booleans/strings: serialized as JSON primitives

## Where it’s implemented

- Indexer HTTP API + snapshot builder: [indexer.js](file:///Volumes/UltraDisk/Dev2/aastar/MyTask/agent-mock/indexer.js)
