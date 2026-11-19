import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PilotManifest } from "./contract";

interface Attempt {
	sequence: number;
	model: string;
	path: string;
	bodyBytes: number;
	request: unknown;
	status: "reserved" | "returned" | "failed";
	httpStatus?: number;
	response?: string;
}

/** Provider-free transport only. This cannot forward to a real provider. */
export async function startScriptedPilotGateway(
	manifest: PilotManifest,
	ledgerPath: string,
	respond: (body: Record<string, unknown>, pathname: string) => Response | Promise<Response>,
) {
	if (manifest.mode !== "scripted")
		throw new Error("Live inference requires a separately verified single-attempt route");
	const attempts: Attempt[] = [];
	let stopped: string | undefined;
	let mutation = Promise.resolve();
	const allowed = new Map([
		[manifest.source.id, manifest.source.api === "anthropic-messages" ? "/v1/messages" : "/v1/responses"],
		[manifest.destination.id, manifest.destination.api === "anthropic-messages" ? "/v1/messages" : "/v1/responses"],
	]);
	await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
	await fs.mkdir(path.dirname(manifest.gatewaySocket), { recursive: true });
	// Reusing an output/ledger or socket can mix runs and hide earlier attempts.
	const claim = await fs.open(ledgerPath, "wx", 0o600);
	await claim.close();
	const persist = async () => {
		const temporary = `${ledgerPath}.pending`;
		const file = await fs.open(temporary, "w", 0o600);
		try {
			await file.writeFile(JSON.stringify({ version: 1, mode: "scripted", stopped, attempts }, null, 2));
			await file.sync();
		} finally {
			await file.close();
		}
		await fs.rename(temporary, ledgerPath);
		const directory = await fs.open(path.dirname(ledgerPath), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	};
	await persist();
	const exclusive = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = mutation.then(operation);
		mutation = result.then(
			() => {},
			() => {},
		);
		return result;
	};
	const reject = (reason: string, status = 400) =>
		new Response(JSON.stringify({ error: { type: "pilot_gateway_rejection", message: reason } }), {
			status,
			headers: { "content-type": "application/json" },
		});
	const server = Bun.serve({
		unix: manifest.gatewaySocket,
		maxRequestBodySize: manifest.maxRequestBodyBytes,
		async fetch(request) {
			return exclusive(async () => {
				if (stopped) return reject(stopped, 503);
				const url = new URL(request.url);
				if (request.method !== "POST" || url.hostname !== "pilot-gateway" || url.search) {
					return reject("Only admitted pilot inference requests are supported");
				}
				const bytes = new Uint8Array(await request.arrayBuffer());
				if (bytes.byteLength > manifest.maxRequestBodyBytes) return reject("Request body exceeds pilot cap", 413);
				let body: Record<string, unknown>;
				try {
					body = JSON.parse(new TextDecoder().decode(bytes));
				} catch {
					return reject("Invalid JSON");
				}
				if (!body || typeof body !== "object" || Array.isArray(body)) return reject("Expected request object");
				if (typeof body.model !== "string" || allowed.get(body.model) !== url.pathname) {
					return reject("Model or protocol is outside the frozen manifest");
				}
				const cap = url.pathname === "/v1/messages" ? body.max_tokens : body.max_output_tokens;
				if (!Number.isSafeInteger(cap) || Number(cap) < 1 || Number(cap) > manifest.maxOutputTokens) {
					return reject("Missing or excessive output cap");
				}
				const attempt: Attempt = {
					sequence: attempts.length + 1,
					model: body.model,
					path: url.pathname,
					bodyBytes: bytes.byteLength,
					request: body,
					status: "reserved",
				};
				attempts.push(attempt);
				try {
					await persist();
					const response = await respond(body, url.pathname);
					const responseBody = await response.text();
					attempt.status = "returned";
					attempt.httpStatus = response.status;
					attempt.response = responseBody;
					if (!response.ok) stopped = `Scripted upstream rejected with HTTP ${response.status}`;
					await persist();
					return new Response(responseBody, { status: response.status, headers: response.headers });
				} catch (error) {
					attempt.status = "failed";
					stopped = error instanceof Error ? error.message : String(error);
					try {
						await persist();
					} catch {
						/* In-memory stop remains latched; no further dispatch. */
					}
					return reject("Gateway stopped after an indeterminate attempt", 503);
				}
			});
		},
	});
	await fs.chmod(manifest.gatewaySocket, 0o600);
	return {
		get requestCount() {
			return attempts.length;
		},
		async close() {
			server.stop(true);
			await mutation;
			await fs.rm(manifest.gatewaySocket, { force: true });
		},
	};
}
