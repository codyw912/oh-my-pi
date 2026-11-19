import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ContinuationOwnerRequest,
	inspectCommittedRunState,
	withContinuationOwner,
} from "../../../src/session/continuation-store";

interface ProcessConfig {
	mode: "hold-owner" | "try-owner" | "hold-worker" | "inspect";
	request?: ContinuationOwnerRequest;
	readyPath: string;
	resultPath: string;
	lockRetries?: number;
}

function errorPayload(error: unknown): { name?: string; message: string; code?: string } {
	if (error instanceof Error) {
		const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
		return { name: error.name, message: error.message, code };
	}
	return { message: String(error) };
}

const configPath = Bun.argv[2];
if (!configPath) throw new Error("run-store-process requires a config path");
const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as ProcessConfig;

function writeResult(payload: unknown): void {
	fs.mkdirSync(path.dirname(config.resultPath), { recursive: true });
	fs.writeFileSync(config.resultPath, `${JSON.stringify(payload)}\n`);
}

function writeReady(payload: unknown = { ready: true }): void {
	fs.mkdirSync(path.dirname(config.readyPath), { recursive: true });
	fs.writeFileSync(config.readyPath, `${JSON.stringify(payload)}\n`);
}

function park(): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

if (config.mode === "hold-worker") {
	writeReady({ pid: process.pid });
	park();
	process.exit(0);
}

if (config.mode === "inspect") {
	if (!config.request) throw new Error("inspect requires request.identity");
	try {
		const inspected = await inspectCommittedRunState(config.request.identity);
		writeResult({ ok: true, state: inspected.state });
		writeReady({ ok: true });
	} catch (error) {
		writeResult({ ok: false, error: errorPayload(error) });
		writeReady({ ok: false });
		process.exit(1);
	}
	process.exit(0);
}

if (!config.request) throw new Error("owner modes require a request");

const lock = { retries: config.lockRetries ?? 1, retryDelayMs: 0 };

try {
	await withContinuationOwner(
		config.request,
		async owner => {
			writeReady({
				pid: process.pid,
				generation: owner.getState().owner.generation,
				runId: owner.getState().run.id,
				lockScope: owner.getLockScope(),
				canAdmitWork: owner.canAdmitWork(),
			});
			if (config.mode === "try-owner") {
				writeResult({
					ok: true,
					generation: owner.getState().owner.generation,
					canAdmitWork: owner.canAdmitWork(),
					pendingEffects: owner.getState().pendingEffects,
					workers: owner.getState().accounting.workers,
				});
				return;
			}
			park();
		},
		{ lock },
	);
} catch (error) {
	const payload = { ok: false, error: errorPayload(error) };
	writeResult(payload);
	if (!fs.existsSync(config.readyPath)) writeReady(payload);
	process.exit(1);
}
