import { createRefund } from "./refund-service.mjs";

const requests = JSON.parse(await new Response(Bun.stdin.stream()).text());
if (!Array.isArray(requests) || requests.length < 1 || requests.length > 40) {
	throw new Error("Expected one to forty bounded probe requests");
}
let response;
for (const request of requests) response = createRefund(request);
console.log(JSON.stringify(response));
