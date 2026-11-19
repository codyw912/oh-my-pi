# Refund API implementation plan

**Spec:** `docs/project/specs/refund-api.md`

## Constraints

- The workspace is frozen for review: do not mutate source or publish.
- Preserve idempotent retry behavior for refund requests.
- Task 2 is a review, not an implementation rewrite.

## Task 1: Implement refund creation — complete

The refund endpoint and visible checks are complete. The implementation accepts a merchant, account, payment, amount, and idempotency key. Basic creation and a repeated request within one merchant are covered.

## Task 2: Review the completed implementation — pending

Review the frozen implementation with code inspection and focused behavioral probes. This is an unresolved investigation, not an accepted defect. Submit an evidence-backed artifact. Keep idempotency; a prior proposal to remove it was rejected because retry safety is a product requirement.
