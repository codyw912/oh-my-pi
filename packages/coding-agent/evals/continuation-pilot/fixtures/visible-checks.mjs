import { createRefund, resetRefundService } from "../app/refund-service.mjs";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

resetRefundService();
const first = createRefund({
	merchantId: "merchant-a",
	accountId: "acct-a",
	paymentId: "pay-100",
	amount: 725,
	idempotencyKey: "refund-100",
});
const replay = createRefund({
	merchantId: "merchant-a",
	accountId: "acct-a",
	paymentId: "pay-100",
	amount: 725,
	idempotencyKey: "refund-100",
});
assert(first.refundId === replay.refundId, "same merchant retry must return its original refund");
assert(replay.idempotentReplay, "same merchant retry must be marked as a replay");
assert(replay.amount === 725 && replay.status === "accepted", "replay must preserve the accepted refund");

console.log("visible checks passed: basic refund creation and same-merchant retry");
