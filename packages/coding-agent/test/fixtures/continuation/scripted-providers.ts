// Synthetic local protocol data. These usage values are not provider measurements.
export function anthropicSse(text: string): Response {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_cont",
				usage: { input_tokens: 8, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(
		`${events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`,
		{
			status: 200,
			headers: { "content-type": "text/event-stream", "request-id": "req_cont" },
		},
	);
}

export function openaiResponsesSse(text: string): Response {
	const events = [
		{ type: "response.created", response: { id: "resp_cont" } },
		{
			type: "response.output_item.added",
			item: { type: "message", id: "msg_cont", role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
		{ type: "response.output_text.delta", delta: text },
		{
			type: "response.output_item.done",
			item: {
				type: "message",
				id: "msg_cont",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{
			type: "response.completed",
			response: {
				id: "resp_cont",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

export function openaiResponsesToolSse(
	name: string,
	args: Record<string, unknown> = {},
	callId = "call_review",
): Response {
	const json = JSON.stringify(args);
	const events = [
		{ type: "response.created", response: { id: "resp_cont_tool" } },
		{
			type: "response.output_item.added",
			item: { type: "function_call", id: "fc_review", call_id: callId, name, arguments: "" },
		},
		{ type: "response.function_call_arguments.delta", delta: json },
		{ type: "response.function_call_arguments.done", arguments: json },
		{
			type: "response.output_item.done",
			item: { type: "function_call", id: "fc_review", call_id: callId, name, arguments: json },
		},
		{
			type: "response.completed",
			response: {
				id: "resp_cont_tool",
				status: "completed",
				usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
			},
		},
	];
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Scripted account exhaustion. The 1200s reset is fake; clients must not wait it. */
export function quotaLimitResponse(): Response {
	return new Response(
		JSON.stringify({
			error: {
				type: "insufficient_quota",
				message: "Usage limit reached. Fake account reset in 1200 seconds.",
			},
		}),
		{
			status: 429,
			headers: { "content-type": "application/json", "retry-after-ms": "0" },
		},
	);
}
