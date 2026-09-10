/**
 * Throwaway-profile, file-backed AgentSession baseline for current newSession
 * behavior. Synthetic model/auth only; no inference. Writes independently
 * inspected measurements to CONTINUATION_BASELINE_OUTPUT.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import "./containment-probe";
import type { CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";

const WORKLOAD_REVISION = "continuation-baseline-workload-v1";

const EVIDENCE_COMPLETED_WORK = "EVIDENCE_COMPLETED_WORK_V1";
const EVIDENCE_UNFINISHED_CONSTRAINT = "EVIDENCE_UNFINISHED_CONSTRAINT_V1";
const EVIDENCE_REJECTED_APPROACH = "EVIDENCE_REJECTED_APPROACH_V1";

const FROZEN_USER_COMPLETED =
	"Completed work: isolated file-backed session harness is in place. " + EVIDENCE_COMPLETED_WORK;
const FROZEN_ASSISTANT_COMPLETED =
	"Recorded completed work in the persisted transcript. " + EVIDENCE_COMPLETED_WORK;
const FROZEN_USER_CONSTRAINT =
	"Unfinished constraint: replacement sessions must keep unresolved limits visible. " +
	EVIDENCE_UNFINISHED_CONSTRAINT;
const FROZEN_ASSISTANT_CONSTRAINT =
	"Constraint remains open; no continuation restoration was implemented. " + EVIDENCE_UNFINISHED_CONSTRAINT;
const FROZEN_USER_REJECTED =
	"Rejected approach: summarizing the transcript and discarding the source. " + EVIDENCE_REJECTED_APPROACH;
const FROZEN_ASSISTANT_REJECTED =
	"Rejected summarize-and-discard; it is not an acceptable restoration path. " + EVIDENCE_REJECTED_APPROACH;

const SECRET_ENV_PATTERN = /(?:KEY|SECRET|TOKEN|PASSWORD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(?:_|$)/i;

const ENV_ALLOWLIST: Record<string, true> = {
	CONTINUATION_PARENT_SENTINEL: true,
	CONTINUATION_FORBIDDEN_URL: true,
	CONTINUATION_BASELINE_OUTPUT: true,
	CONTINUATION_SJUJPERPOWERS_SOURCE: true,
	CONTINUATION_SJUJPERPOWERS_REV: true,
	CONTINUATION_SOURCE_REV: true,
	CONTINUATION_NATIVE_ADDON: true,
	CONTINUATION_BUN_VERSION: true,
	BUN_INSTALL_CACHE_DIR: true,
	NIX_BUILD_TOP: true,
	NIX_BUILD_CORES: true,
	NIX_LOG_FD: true,
	NIX_STORE: true,
	TMPDIR: true,
	HOME: true,
	PI_CONFIG_DIR: true,
	PI_CODING_AGENT_DIR: true,
};

const REQUIRED_ISOLATION_ENV = [
	"HOME",
	"TMPDIR",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"PI_CODING_AGENT_DIR",
	"PI_CONFIG_DIR",
] as const;

function fail(message: string): never {
	console.error(`continuation-baseline: ${message}`);
	process.exit(1);
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value || value.trim() === "") {
		fail(`missing required environment variable ${name}`);
	}
	return value;
}

function builderTempRoots(): string[] {
	const roots: string[] = [];
	for (const name of ["TMPDIR", "NIX_BUILD_TOP"] as const) {
		const value = process.env[name];
		if (value && value.trim() !== "") roots.push(path.resolve(value));
	}
	if (roots.length === 0) fail("TMPDIR or NIX_BUILD_TOP must be set to the builder temp");
	return [...new Set(roots)];
}

function isPathInside(root: string, target: string): boolean {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	const relative = path.relative(resolvedRoot, resolvedTarget);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isUnderBuilderTemp(target: string): boolean {
	return builderTempRoots().some(root => isPathInside(root, target));
}

function assertNoCredentialEnv(): void {
	const leaked: string[] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (!value) continue;
		if (ENV_ALLOWLIST[name] || name.startsWith("XDG_")) continue;
		if (!SECRET_ENV_PATTERN.test(name)) continue;
		leaked.push(name);
	}
	if (leaked.length > 0) {
		fail(`credential-like environment variables present: ${leaked.sort().join(", ")}`);
	}
}

function assertScratchPathsAreTemporary(): void {
	for (const name of REQUIRED_ISOLATION_ENV) {
		const value = requireEnv(name);
		if (name === "PI_CONFIG_DIR" && !path.isAbsolute(value)) continue;
		if (!isUnderBuilderTemp(value)) {
			fail(`${name} is not under $TMPDIR or $NIX_BUILD_TOP`);
		}
	}
	if (!isUnderBuilderTemp(os.homedir())) fail("os.homedir() is not under the builder temp");
	if (!isUnderBuilderTemp(os.tmpdir())) fail("os.tmpdir() is not under the builder temp");
	const home = path.resolve(requireEnv("HOME"));
	if (
		(home === "/root" || home.startsWith("/home/") || home.startsWith("/Users/")) &&
		!isUnderBuilderTemp(home)
	) {
		fail(`HOME looks like a real user home: ${home}`);
	}
}

function assertSentinelUnreadableIfProvided(): void {
	const sentinel = process.env.CONTINUATION_PARENT_SENTINEL;
	if (!sentinel) return;
	const resolved = path.resolve(sentinel);
	if (isPathInside(path.resolve(requireEnv("HOME")), resolved)) {
		fail("parent-home sentinel resolves inside isolated HOME");
	}
	try {
		fs.readFileSync(resolved);
		fail("parent-home sentinel was readable from the sandbox");
	} catch (error) {
		let code = "";
		if (error !== null && typeof error === "object" && "code" in error && error.code !== undefined) {
			code = String(error.code);
		}
		if (code === "" || code === "ERR_INVALID_ARG") {
			fail(`parent-home sentinel read failed without an isolation error: ${String(error)}`);
		}
	}
}

function frozenAssistant(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "mock" as const,
		model: "continuation-baseline-mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

function evidenceIn(haystack: string): {
	completedWork: boolean;
	unfinishedConstraint: boolean;
	rejectedApproach: boolean;
} {
	return {
		completedWork: haystack.includes(EVIDENCE_COMPLETED_WORK),
		unfinishedConstraint: haystack.includes(EVIDENCE_UNFINISHED_CONSTRAINT),
		rejectedApproach: haystack.includes(EVIDENCE_REJECTED_APPROACH),
	};
}

async function directoryByteSize(root: string): Promise<number> {
	let total = 0;
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		const entries = await fs.promises.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			total += (await fs.promises.stat(full)).size;
		}
	}
	return total;
}

async function readOptionalPackageVersion(source: string): Promise<string | null> {
	try {
		const parsed: unknown = JSON.parse(await Bun.file(path.join(source, "package.json")).text());
		if (parsed !== null && typeof parsed === "object" && "version" in parsed && typeof parsed.version === "string") {
			return parsed.version;
		}
	} catch {
		return null;
	}
	return null;
}

async function writeReport(outputPath: string, report: unknown): Promise<void> {
	await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
	await Bun.write(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

async function main(): Promise<void> {
	assertNoCredentialEnv();
	assertScratchPathsAreTemporary();
	assertSentinelUnreadableIfProvided();

	const outputPath = requireEnv("CONTINUATION_BASELINE_OUTPUT");
	if (!isUnderBuilderTemp(outputPath)) {
		fail("CONTINUATION_BASELINE_OUTPUT is not under $TMPDIR or $NIX_BUILD_TOP");
	}

	const bunVersion = requireEnv("CONTINUATION_BUN_VERSION");
	const nativeAddon = requireEnv("CONTINUATION_NATIVE_ADDON");
	const sourceRev = requireEnv("CONTINUATION_SOURCE_REV");
	const sjujperpowersRev = requireEnv("CONTINUATION_SJUJPERPOWERS_REV");
	const sjujperpowersSource = requireEnv("CONTINUATION_SJUJPERPOWERS_SOURCE");
	const home = requireEnv("HOME");
	const agentDir = requireEnv("PI_CODING_AGENT_DIR");

	const report: Record<string, unknown> = {
		ok: false,
		workloadRevision: WORKLOAD_REVISION,
		bunVersion,
		observedBunVersion: Bun.version,
		nativeAddon,
		sourceRev,
		sjujperpowersRev,
		sjujperpowersSource,
		platform: process.platform,
		arch: process.arch,
		inference: "none",
		requestCount: 0,
	};

	try {
		// Exercise SDK loading only after containment proof; static SDK imports would run before that guard.
		const [
			{ createAgentSession },
			{ createMockModel },
			{ AuthStorage },
			{ SessionManager },
			{ Settings },
			{ ModelRegistry },
			utils,
		] = await Promise.all([
			import("@oh-my-pi/pi-coding-agent/sdk"),
			import("@oh-my-pi/pi-ai/providers/mock"),
			import("@oh-my-pi/pi-coding-agent/session/auth-storage"),
			import("@oh-my-pi/pi-coding-agent/session/session-manager"),
			import("@oh-my-pi/pi-coding-agent/config/settings"),
			import("@oh-my-pi/pi-coding-agent/config/model-registry"),
			import("@oh-my-pi/pi-utils"),
		]);

		report.ompVersion = utils.VERSION;
		report.sjujperpowersPackageVersion = await readOptionalPackageVersion(sjujperpowersSource);

		const projectDir = path.join(home, "continuation-baseline-project");
		const sessionsDir = path.join(agentDir, "continuation-baseline-sessions");
		const authPath = path.join(agentDir, "continuation-baseline-auth.db");
		await fs.promises.mkdir(projectDir, { recursive: true });
		await fs.promises.mkdir(sessionsDir, { recursive: true });

		const bytesBefore = await directoryByteSize(sessionsDir);
		const authStorage = await AuthStorage.create(authPath);
		authStorage.setRuntimeApiKey("mock", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "continuation-baseline-models.yml"));
		const mock = createMockModel({ id: "continuation-baseline-mock" });
		const isolatedSettings = Settings.isolated({
			"compaction.enabled": false,
			"async.enabled": false,
			"advisor.enabled": false,
		});

		const sessionOptions: Omit<CreateAgentSessionOptions, "sessionManager"> = {
			cwd: projectDir,
			agentDir,
			authStorage,
			modelRegistry,
			model: mock,
			getApiKey: () => "test-key",
			settings: isolatedSettings,
			disableExtensionDiscovery: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		};

		const createdManager = SessionManager.create(projectDir, sessionsDir);
		const createStarted = performance.now();
		const created = await createAgentSession({
			...sessionOptions,
			sessionManager: createdManager,
		});
		const createMs = performance.now() - createStarted;

		const persistStarted = performance.now();
		created.session.sessionManager.appendMessage({
			role: "user",
			content: FROZEN_USER_COMPLETED,
			timestamp: 1,
		});
		created.session.sessionManager.appendMessage(frozenAssistant(FROZEN_ASSISTANT_COMPLETED, 2));
		created.session.sessionManager.appendMessage({
			role: "user",
			content: FROZEN_USER_CONSTRAINT,
			timestamp: 3,
		});
		created.session.sessionManager.appendMessage(frozenAssistant(FROZEN_ASSISTANT_CONSTRAINT, 4));
		created.session.sessionManager.appendMessage({
			role: "user",
			content: FROZEN_USER_REJECTED,
			timestamp: 5,
		});
		created.session.sessionManager.appendMessage(frozenAssistant(FROZEN_ASSISTANT_REJECTED, 6));
		await created.session.sessionManager.flush();
		await created.session.sessionManager.ensureOnDisk();
		const persistMs = performance.now() - persistStarted;

		const originalFile = created.session.sessionFile;
		if (!originalFile) throw new Error("file-backed session did not allocate a session file");
		if (!(await Bun.file(originalFile).exists())) throw new Error("persisted session file is missing on disk");
		const originalBytes = await Bun.file(originalFile).text();
		const serializedBytes = Buffer.byteLength(originalBytes);
		const bytesAfterPersist = await directoryByteSize(sessionsDir);
		const originalEvidence = evidenceIn(originalBytes);
		const originalEntryEvidence = evidenceIn(JSON.stringify(created.session.sessionManager.getEntries()));
		const createdSessionId = created.session.sessionId;
		await created.session.dispose();

		const reloadStarted = performance.now();
		const reopenedManager = await SessionManager.open(originalFile, sessionsDir);
		const reloaded = await createAgentSession({
			...sessionOptions,
			sessionManager: reopenedManager,
		});
		const reloadMs = performance.now() - reloadStarted;
		const reloadedFileBytes = await Bun.file(originalFile).text();
		const reloadFileEvidence = evidenceIn(reloadedFileBytes);
		const reloadEntryEvidence = evidenceIn(JSON.stringify(reloaded.session.sessionManager.getEntries()));
		const reloadAgentEvidence = evidenceIn(JSON.stringify(reloaded.session.messages));
		const reloadAgentMessageCount = reloaded.session.messages.length;
		const reloadEntryCount = reloaded.session.sessionManager.getEntries().length;

		const previousSessionId = reloaded.session.sessionId;
		const previousFile = reloaded.session.sessionFile;
		if (!previousFile) throw new Error("reloaded session has no session file");
		const newSessionStarted = performance.now();
		const newSessionReturned = await reloaded.session.newSession();
		const newSessionMs = performance.now() - newSessionStarted;
		const newFile = reloaded.session.sessionFile;
		if (!newFile) throw new Error("newSession did not allocate a replacement session file");
		await reloaded.session.sessionManager.flush();
		await reloaded.session.sessionManager.ensureOnDisk();
		const newFileBytes = (await Bun.file(newFile).exists()) ? await Bun.file(newFile).text() : "";
		const previousFileAfter = (await Bun.file(previousFile).exists()) ? await Bun.file(previousFile).text() : "";
		const newFileEvidence = evidenceIn(newFileBytes);
		const previousFileAfterEvidence = evidenceIn(previousFileAfter);
		const newEntryEvidence = evidenceIn(JSON.stringify(reloaded.session.sessionManager.getEntries()));
		const newAgentEvidence = evidenceIn(JSON.stringify(reloaded.session.messages));
		const newAgentMessageCount = reloaded.session.messages.length;
		const newEntryCount = reloaded.session.sessionManager.getEntries().length;
		const newSessionId = reloaded.session.sessionId;
		const bytesAfterNewSession = await directoryByteSize(sessionsDir);
		const requestCount = mock.calls.length;
		if (requestCount !== 0) throw new Error("zero-inference baseline unexpectedly requested model output");

		await reloaded.session.dispose();
		authStorage.close();

		const observations: string[] = [];
		if (originalEvidence.completedWork && originalEvidence.unfinishedConstraint && originalEvidence.rejectedApproach) {
			observations.push("Persisted JSONL contains completed work, unfinished constraint, and rejected-approach markers.");
		} else {
			observations.push("One or more frozen evidence markers were absent from the persisted JSONL.");
		}
		if (reloadFileEvidence.completedWork && reloadAgentEvidence.completedWork) {
			observations.push("Reloading the original session file restored completed-work evidence into AgentSession.messages.");
		} else {
			observations.push("Reload did not restore completed-work evidence into both the file and AgentSession.messages.");
		}
		if (
			previousFileAfterEvidence.completedWork &&
			previousFileAfterEvidence.unfinishedConstraint &&
			previousFileAfterEvidence.rejectedApproach
		) {
			observations.push("After newSession, the previous session file still contains all frozen evidence markers.");
		} else {
			observations.push("After newSession, the previous session file is missing frozen evidence markers.");
		}
		if (newFileEvidence.completedWork || newAgentEvidence.completedWork || newEntryEvidence.completedWork) {
			observations.push("Current newSession carried completed-work evidence into the replacement session.");
		} else {
			observations.push(
				"Current newSession did not restore completed-work evidence into the replacement session file or live messages.",
			);
		}
		if (newFileEvidence.unfinishedConstraint || newAgentEvidence.unfinishedConstraint) {
			observations.push("Current newSession carried unfinished-constraint evidence into the replacement session.");
		} else {
			observations.push("Current newSession did not restore unfinished-constraint evidence into the replacement session.");
		}
		if (newFileEvidence.rejectedApproach || newAgentEvidence.rejectedApproach) {
			observations.push("Current newSession carried rejected-approach evidence into the replacement session.");
		} else {
			observations.push("Current newSession did not restore rejected-approach evidence into the replacement session.");
		}
		observations.push(`Zero-inference path: mock.calls.length=${requestCount}.`);
		if (bunVersion !== Bun.version) {
			observations.push(`CONTINUATION_BUN_VERSION=${bunVersion} differs from Bun.version=${Bun.version}.`);
		}

		const limitations = [
			"No live model inference was invoked; requestCount is the mock provider call list, not a token or quality metric.",
			"Serialized byte counts include runtime-assigned session header/entry timestamps, so they are not bitwise-reproducible.",
			"Write footprint is the sessions-directory size delta, not block-layer or filesystem journal writes.",
			"Session used Settings.isolated with extensions/MCP/LSP disabled; it is not a full interactive tool slate.",
			"This records current newSession behavior only. It does not implement continuation and makes no savings claims.",
		];
		if (report.sjujperpowersPackageVersion === null) {
			limitations.push("sjujperpowers package.json version could not be read from CONTINUATION_SJUJPERPOWERS_SOURCE.");
		}

		Object.assign(report, {
			ok: true,
			input: {
				workloadRevision: WORKLOAD_REVISION,
				evidenceRefs: {
					completedWork: EVIDENCE_COMPLETED_WORK,
					unfinishedConstraint: EVIDENCE_UNFINISHED_CONSTRAINT,
					rejectedApproach: EVIDENCE_REJECTED_APPROACH,
				},
				messages: [
					FROZEN_USER_COMPLETED,
					FROZEN_ASSISTANT_COMPLETED,
					FROZEN_USER_CONSTRAINT,
					FROZEN_ASSISTANT_CONSTRAINT,
					FROZEN_USER_REJECTED,
					FROZEN_ASSISTANT_REJECTED,
				],
			},
			requestCount,
			tests: {
				create: {
					elapsedMs: createMs,
					sessionId: createdSessionId,
					sessionFile: originalFile,
					onDisk: true,
				},
				persist: {
					elapsedMs: persistMs,
					serializedBytes,
					writeFootprintBytes: bytesAfterPersist - bytesBefore,
					evidenceInFile: originalEvidence,
					evidenceInEntries: originalEntryEvidence,
				},
				reload: {
					elapsedMs: reloadMs,
					serializedBytes: Buffer.byteLength(reloadedFileBytes),
					evidenceInFile: reloadFileEvidence,
					evidenceInEntries: reloadEntryEvidence,
					evidenceInAgentMessages: reloadAgentEvidence,
					agentMessageCount: reloadAgentMessageCount,
					entryCount: reloadEntryCount,
				},
				newSession: {
					elapsedMs: newSessionMs,
					returned: newSessionReturned,
					previousSessionId,
					newSessionId,
					previousFile,
					newFile,
					newFileSerializedBytes: Buffer.byteLength(newFileBytes),
					writeFootprintBytes: bytesAfterNewSession - bytesBefore,
					evidenceInPreviousFile: previousFileAfterEvidence,
					evidenceInNewFile: newFileEvidence,
					evidenceInNewEntries: newEntryEvidence,
					evidenceInAgentMessages: newAgentEvidence,
					agentMessageCount: newAgentMessageCount,
					entryCount: newEntryCount,
				},
			},
			observations,
			limitations,
		});
		await writeReport(outputPath, report);
	} catch (error) {
		report.error = error instanceof Error ? error.message : String(error);
		try {
			await writeReport(outputPath, report);
		} catch (writeError) {
			console.error(`continuation-baseline: failed to preserve measurement metadata: ${String(writeError)}`);
		}
		fail(error instanceof Error ? error.message : String(error));
	}
}

await main();
