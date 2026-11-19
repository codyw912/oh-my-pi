const idempotencyResults = new Map();
let nextRefund = 1;

function requireText(value, name) {
	if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} must be a non-empty string`);
	return value;
}

function requireAmount(value) {
	if (!Number.isInteger(value) || value <= 0) throw new TypeError("amount must be a positive integer");
	return value;
}

export function resetRefundService() {
	idempotencyResults.clear();
	nextRefund = 1;
}

export function createRefund({ merchantId, accountId, paymentId, amount, idempotencyKey }) {
	requireText(merchantId, "merchantId");
	requireText(accountId, "accountId");
	requireText(paymentId, "paymentId");
	requireAmount(amount);
	requireText(idempotencyKey, "idempotencyKey");

	const prior = idempotencyResults.get(idempotencyKey);
	if (prior) return { ...prior, idempotentReplay: true };

	const refund = {
		refundId: `rf_${nextRefund++}`,
		merchantId,
		accountId,
		paymentId,
		amount,
		status: "accepted",
		idempotentReplay: false,
	};
	idempotencyResults.set(idempotencyKey, refund);
	return { ...refund };
}
