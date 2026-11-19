import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { PilotManifest } from "./contract";
import frozenManifest from "./manifest.json";
import liveManifest from "./live-manifest.json";
import { runPilot } from "./runner";
import { startScriptedPilotGateway } from "./scripted-gateway";
import { createPilotWorkload } from "./workload";
import { anthropicToolUseSse } from "../../test/fixtures/continuation/portable-session";
import {
	anthropicSse,
	openaiResponsesSse,
	openaiResponsesToolSse,
} from "../../test/fixtures/continuation/scripted-providers";

const temporaryRoots: string[] = [];
const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
	for (const root of temporaryRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function setup() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pilot-"));
	temporaryRoots.push(root);
	const manifest = { ...frozenManifest, gatewaySocket: path.join(root, "gateway.sock") } as PilotManifest;
	return { root, manifest };
}
async function request(manifest: PilotManifest, changes: Record<string, unknown> = {}) {
	return fetch("http://pilot-gateway/v1/messages", {
		unix: manifest.gatewaySocket,
		method: "POST",
		body: JSON.stringify({ model: manifest.source.id, max_tokens: manifest.maxOutputTokens, messages: [], stream: true, ...changes }),
		headers: { "content-type": "application/json" },
	});
}

const probe = {
	merchantId: "merchant-a",
	accountId: "account-a",
	paymentId: "payment-a",
	amount: 100,
	idempotencyKey: "retry-key",
};
const report =
	"probe-1 creates a merchant-a refund. probe-2 requests merchant-b but returns merchant-a's refund as an idempotent replay. Scope the idempotency lookup by merchant and account as well as key; preserve retries within that scope. Add isolation regression coverage. This is an observed cross-merchant result disclosure, not proof of additional money movement.";

test("live or unknown modes refuse before workspace or gateway creation", async () => {
	const { root, manifest } = await setup();
	const output = path.join(root, "must-not-exist");
	await expect(runPilot({ ...manifest, mode: "live" }, output)).rejects.toThrow("single-attempt");
	await expect(
		startScriptedPilotGateway({ ...manifest, mode: "live" }, path.join(output, "ledger.json"), () => new Response()),
	).rejects.toThrow("single-attempt");
	await expect(fs.stat(output)).rejects.toHaveProperty("code", "ENOENT");
});

test("every frozen live field rejects mutation before creating evidence", async () => {
	const { root } = await setup();
	const previous = process.env.CONTINUATION_PILOT_LIVE_APPROVED;
	process.env.CONTINUATION_PILOT_LIVE_APPROVED = "agent-13-fireworks-five-dollars";
	try {
		for (const [key, value] of Object.entries(liveManifest)) {
			const changed = {
				...liveManifest,
				[key]:
					typeof value === "number"
						? value + 1
						: typeof value === "boolean"
							? !value
							: typeof value === "object"
								? { ...value, maxTokens: value.maxTokens + 1 }
								: "unapproved",
			} as unknown as PilotManifest;
			const output = path.join(root, key);
			await expect(runPilot(changed, output)).rejects.toThrow();
			await expect(fs.stat(output)).rejects.toHaveProperty("code", "ENOENT");
		}
	} finally {
		if (previous === undefined) delete process.env.CONTINUATION_PILOT_LIVE_APPROVED;
		else process.env.CONTINUATION_PILOT_LIVE_APPROVED = previous;
	}
});

test("scripted mode cannot select the live relay socket", async () => {
	const { root } = await setup();
	const output = path.join(root, "must-not-exist");
	await expect(runPilot({ ...liveManifest, mode: "scripted" } as PilotManifest, output)).rejects.toThrow(
		"live relay socket",
	);
	await expect(fs.stat(output)).rejects.toHaveProperty("code", "ENOENT");
});

test.each(["anthropic-messages", "openai-responses"] as const)(
	"%s retries cannot issue a second wire POST",
	async api => {
		const { root, manifest } = await setup();
		if (api === "openai-responses") {
			[manifest.source, manifest.destination] = [manifest.destination, manifest.source];
		}
		const gateway = await startScriptedPilotGateway(
			manifest,
			path.join(root, "ledger.json"),
			() => new Response("upstream failed", { status: 503 }),
		);
		closers.push(gateway.close);
		const output = path.join(root, "failed-output");
		await expect(runPilot(manifest, output)).rejects.toThrow("Primer failed");
		const primer = JSON.parse(await fs.readFile(path.join(output, "primer.json"), "utf8"));
		expect(primer.wire.filter((entry: { requestBody?: string }) => entry.requestBody !== undefined)).toHaveLength(1);
		expect(gateway.requestCount).toBe(1);
	},
	120_000,
);

test("empty completions do not trigger provider replay", async () => {
	const { root, manifest } = await setup();
	const gateway = await startScriptedPilotGateway(manifest, path.join(root, "ledger.json"), (_body, pathname) =>
		pathname === "/v1/messages" ? anthropicSse("") : openaiResponsesSse(""),
	);
	closers.push(gateway.close);
	await runPilot(manifest, path.join(root, "empty-output"));
	expect(gateway.requestCount).toBe(7);
}, 120_000);

test("unapproved model and excessive output never reach the responder", async () => {
	const { root, manifest } = await setup();
	let dispatched = 0;
	const gateway = await startScriptedPilotGateway(manifest, path.join(root, "ledger.json"), () => {
		dispatched++;
		return new Response("ok");
	});
	closers.push(gateway.close);
	expect((await request(manifest, { model: "unapproved" })).status).toBe(400);
	expect((await request(manifest, { max_tokens: manifest.maxOutputTokens + 1 })).status).toBe(400);
	expect(dispatched).toBe(0);
});

test("a failed upstream attempt consumes budget and latches dispatch closed", async () => {
	const { root, manifest } = await setup();
	let dispatched = 0;
	const gateway = await startScriptedPilotGateway(manifest, path.join(root, "ledger.json"), () => {
		dispatched++;
		return new Response("quota refused", { status: 429 });
	});
	closers.push(gateway.close);
	expect((await request(manifest)).status).toBe(429);
	expect((await request(manifest)).status).toBe(503);
	expect(dispatched).toBe(1);
	expect(gateway.requestCount).toBe(1);
});

test("private evidence remains outside workspace reads and fabricated citations fail", async () => {
	const { root } = await setup();
	const workload = await createPilotWorkload(path.join(root, "workspace"));
	const read = workload.tools.find(tool => tool.name === "read_workspace_file")!;
	const submit = workload.tools.find(tool => tool.name === "submit_review_artifact")!;
	await fs.writeFile(path.join(root, "hidden.txt"), "private-answer");
	await fs.symlink(root, path.join(workload.root, "escape"));
	for (const candidate of [
		"../hidden.txt",
		path.join(root, "hidden.txt"),
		"escape/hidden.txt",
		"fixtures/review-rubric.json",
	]) {
		const result = await read.execute("read", { path: candidate });
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private-answer");
	}
	await submit.execute("submit", { report: "The implementation is fine; see probe-99." });
	const verification = await workload.verify();
	expect(verification.checks.find(check => check.id === "report-references-observed-probes")?.passed).toBe(false);
	expect(verification.checks.find(check => check.id === "cites-cross-scope-observation")?.passed).toBe(false);
});

test("visible checks pass but genuine scoped replay evidence exposes the review defect", async () => {
	const { root } = await setup();
	const workload = await createPilotWorkload(path.join(root, "workspace"));
	const tool = (name: string) => workload.tools.find(candidate => candidate.name === name)!;
	expect((await tool("run_visible_checks").execute("checks", {})).isError).not.toBe(true);
	await tool("probe_refund_service").execute("a", probe);
	const cross = await tool("probe_refund_service").execute("b", {
		...probe,
		merchantId: "merchant-b",
		accountId: "account-b",
	});
	expect(cross.details).toMatchObject({
		id: "probe-2",
		request: { merchantId: "merchant-b" },
		response: { merchantId: "merchant-a", idempotentReplay: true },
	});
	await tool("submit_review_artifact").execute("submit", { report });
	expect((await workload.verify()).checks.every(check => check.passed)).toBe(true);
	await fs.appendFile(path.join(workload.root, "app/refund-service.mjs"), "\n// mutation\n");
	expect((await workload.verify()).checks.find(check => check.id === "workspace-integrity")?.passed).toBe(false);
});

test("six provider-free continuations exercise actual sessions and both wire protocols", async () => {
	const { root, manifest } = await setup();
	manifest.source = liveManifest.source as PilotManifest["source"];
	manifest.destination = liveManifest.destination as PilotManifest["destination"];
	manifest.route = "direct-fireworks";
	const output = path.join(root, "output");
	let calls = 0;
	let suppliedFiles = false;
	const gateway = await startScriptedPilotGateway(manifest, path.join(root, "ledger.json"), async (body, pathname) => {
		const serial = ++calls;
		const anthropic = pathname === "/v1/messages";
		const text = (value: string) => (anthropic ? anthropicSse(value) : openaiResponsesSse(value));
		const call = async (name: string, args: Record<string, unknown>) => {
			if (!anthropic) return openaiResponsesToolSse(name, args, `call_${serial}`);
			const response = anthropicToolUseSse(name, args);
			return new Response((await response.text()).replaceAll("toolu_review", `toolu_${serial}`), {
				headers: response.headers,
			});
		};
		if (serial === 1) {
			const prompt = (body.messages as { content: string }[])[0].content;
			try {
				const packet = JSON.parse(prompt) as { files: string[] };
				expect(packet.files.every(file => typeof file === "string")).toBe(true);
				suppliedFiles =
					packet.files.includes("app/refund-service.mjs") &&
					packet.files.includes("docs/project/plans/refund-idempotency.md");
			} catch {
				suppliedFiles = false;
			}
		}
		const primerRequests = 5;
		// Path-only primer: extra workspace reads, no bundle tool or fixture preload.
		if (!suppliedFiles && serial <= primerRequests) {
			return serial === 1
				? call("run_visible_checks", {})
				: call("read_workspace_file", { path: ["README.md", "package.json", ".", "src"][serial - 2] });
		}
		if (serial <= primerRequests) {
			expect(body.model).toBe(manifest.source.id);
			const files = [
				"app/refund-service.mjs",
				"checks/visible-checks.mjs",
				"docs/project/evidence/task-1-completion.md",
				"docs/project/plans/refund-idempotency.md",
			];
			return serial < primerRequests
				? call("read_workspace_file", { path: files[serial - 1] })
				: text(
						"Task 1 implemented refund creation and visible checks. Task 2 review remains unfinished. Preserve retry safety, do not mutate or publish. Inspect the implementation and probe boundaries.",
					);
		}
		const trial = Math.floor((serial - primerRequests - 1) / 6);
		expect(body.model).toBe(trial === 0 || trial === 5 ? manifest.source.id : manifest.destination.id);
		switch ((serial - primerRequests - 1) % 6) {
			case 0:
				return call("read_workspace_file", { path: "app/refund-service.mjs" });
			case 1:
				return call("run_visible_checks", {});
			case 2:
				return call("probe_refund_service", probe);
			case 3:
				return call("probe_refund_service", { ...probe, merchantId: "merchant-b", accountId: "account-b" });
			case 4:
				return call("submit_review_artifact", { report });
			default:
				return text("Review artifact submitted with probe-1 and probe-2. No source changes.");
		}
	});
	closers.push(gateway.close);
	const manifestPath = path.join(root, "manifest.json");
	await fs.writeFile(manifestPath, JSON.stringify(manifest));
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "main.ts"), "--manifest", manifestPath, "--output", output],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	await fs.writeFile(path.join(root, "cli.json"), JSON.stringify({ stdout, stderr, exitCode }));
	const evidenceRoot = process.env.CONTINUATION_EVIDENCE_DIR;
	if (evidenceRoot) {
		await fs.cp(output, path.join(evidenceRoot, "pilot-scripted"), { recursive: true });
		await fs.copyFile(
			path.join(root, "ledger.json"),
			path.join(evidenceRoot, "pilot-scripted", "gateway-ledger.json"),
		);
		await fs.copyFile(path.join(root, "cli.json"), path.join(evidenceRoot, "pilot-scripted", "cli.json"));
	}
	if (exitCode !== 0) throw new Error(`Pilot CLI exited ${exitCode}: ${stderr}`);
	const primer = JSON.parse(await fs.readFile(path.join(output, "primer.json"), "utf8"));
	expect(primer.stage.calls).toBeGreaterThan(4);
	expect(primer.wire.filter((entry: { requestBody?: string }) => entry.requestBody !== undefined)).toHaveLength(
		primer.stage.calls,
	);
	const ids = ["r1-ordinary", "r1-focused", "r1-full-history", "r2-full-history", "r2-focused", "r2-ordinary"];
	const results = await Promise.all(
		ids.map(async id => JSON.parse(await fs.readFile(path.join(output, "trials", id, "result.json"), "utf8"))),
	);
	for (const result of results) {
		expect(result.error).toBeUndefined();
		expect(result.verification.checks.every((check: { passed: boolean }) => check.passed)).toBe(true);
		expect(result.stage.calls).toBe(6);
		expect(result.wire.filter((entry: { requestBody?: string }) => entry.requestBody !== undefined)).toHaveLength(
			result.stage.calls,
		);
		if (result.trial.strategy === "focused") {
			const receipts = [];
			for await (const file of new Bun.Glob("**/event-http-*.json").scan({
				cwd: path.join(output, "workspaces", result.trial.id, ".sjujperpowers"),
				dot: true,
				absolute: true,
			}))
				receipts.push(JSON.parse(await fs.readFile(file, "utf8")));
			const intents = receipts.filter(receipt => receipt.event === "http-intent");
			const responses = receipts.filter(receipt => receipt.event === "http-response");
			expect(intents).toHaveLength(result.stage.calls);
			expect(new Set(intents.map(receipt => receipt.payload.id)).size).toBe(result.stage.calls);
			expect(new Set(responses.map(receipt => receipt.payload.id))).toEqual(
				new Set(intents.map(receipt => receipt.payload.id)),
			);
		}
	}
	expect(calls).toBeGreaterThan(40);
	expect(calls).toBe(primer.stage.calls + results.reduce((total, result) => total + result.stage.calls, 0));
	await expect(
		startScriptedPilotGateway(manifest, path.join(root, "ledger.json"), () => new Response()),
	).rejects.toHaveProperty("code", "EEXIST");
}, 120_000);
