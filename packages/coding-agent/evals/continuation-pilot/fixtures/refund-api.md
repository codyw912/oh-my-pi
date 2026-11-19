# Refund API

`createRefund` accepts `merchantId`, `accountId`, `paymentId`, `amount`, and `idempotencyKey`. It returns an accepted refund record.

Clients may retry a request after an uncertain network outcome. A retry must return the original result for that request without creating another refund. Merchant and account boundaries are part of the request's authorization and result ownership.
