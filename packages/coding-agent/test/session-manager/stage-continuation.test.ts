import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ThinkingLevel, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ContinuationStageSessionRequest } from "@oh-my-pi/pi-coding-agent/session/continuation-handoff";
import type { ContinuationDestination } from "@oh-my-pi/pi-coding-agent/session/continuation-policy";
import { ContinuationStoreError, sha256Bytes } from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { CONTINUATION_PROTECTED_CONTEXT_TYPE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { FileSessionStorage, MemorySessionStorage } from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { getLatestTodoPhasesFromEntries } from "@oh-my-pi/pi-coding-agent/tools/todo";
import { TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./helpers";

const DESTINATION: ContinuationDestination = {
	provider: "openai",
	account: "acct-dest",
	model: "scripted-dest-model",
	roles: ["primary"],
	settings: { thinkingLevel: ThinkingLevel.High, serviceTier: "flex" },
	dataScope: "workspace-fixture",
};

const BRIEFING_TEXT = "PROTECTED_CONSTRAINT\nContinue from the portable briefing.";
const SOURCE_HISTORY = "SOURCE_HISTORY_MUST_NOT_APPEAR";
const QUEUED_USER = "QUEUED_USER_INPUT";
const QUEUED_DEVELOPER = "QUEUED_DEVELOPER_INSTRUCTION";
const DRAFT_TEXT = "unsent destination draft";
const TODO_CONTENT = "canonical todo";

function jsonlFiles(dir: string): string[] {
	return fs
		.readdirSync(dir)
		.filter(name => name.endsWith(".jsonl"))
		.sort();
}

function textOf(message: AgentMessage): string {
	if (!("content" in message)) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (
			part &&
			typeof part === "object" &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
		) {
			parts.push(part.text);
		}
	}
	return parts.join("");
}

function stageRequest(
	source: SessionManager,
	evidencePath: string,
	overrides: Partial<ContinuationStageSessionRequest> = {},
): ContinuationStageSessionRequest {
	return {
		planPath: "docs/plans/example.md",
		runId: "run-stage-1",
		sourceSessionId: source.getSessionId(),
		generation: 1,
		destination: DESTINATION,
		briefing: {
			text: BRIEFING_TEXT,
			evidence: [],
			byteLength: Buffer.byteLength(BRIEFING_TEXT),
			protectedFacts: ["PROTECTED_CONSTRAINT"],
		},
		todos: [{ id: "t1", content: TODO_CONTENT, status: "pending" }],
		queuedMessages: [
			{ role: "user", content: QUEUED_USER, timestamp: 2 },
			{ role: "developer", content: QUEUED_DEVELOPER, timestamp: 3 },
		],
		draft: DRAFT_TEXT,
		roleObligations: ["ROLE_OBLIGATION_REVIEWER"],
		services: [],
		evidencePath,
		...overrides,
	};
}

describe("SessionManager.stageContinuation", () => {
	it("stages a portable independent session without mutating the source", async () => {
		using tempDir = TempDir.createSync("@omp-stage-continuation-happy-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		const storage = new FileSessionStorage();
		const source = SessionManager.create(cwd, sessionDir, storage);
		source.appendMessage({ role: "user", content: SOURCE_HISTORY, timestamp: 1 });
		source.appendMessage(makeAssistantMessage());
		await source.ensureOnDisk();
		const sourceId = source.getSessionId();
		const sourceFile = source.getSessionFile();
		const sourceEntryCount = source.getEntries().length;
		if (!sourceFile) throw new Error("expected source session file");

		const evidencePath = path.join(tempDir.path(), "retained", "staged.jsonl");
		const staged = await source.stageContinuation(stageRequest(source, evidencePath));

		expect(source.getSessionId()).toBe(sourceId);
		expect(source.getSessionFile()).toBe(sourceFile);
		expect(source.getEntries()).toHaveLength(sourceEntryCount);
		expect(
			source
				.getEntries()
				.some(
					entry =>
						entry.type === "message" && entry.message.role === "user" && textOf(entry.message) === SOURCE_HISTORY,
				),
		).toBe(true);
		expect(staged.sessionId).not.toBe(sourceId);
		expect(staged.sessionFile).not.toBe(sourceFile);
		expect(fs.existsSync(staged.sessionFile)).toBe(true);
		expect(fs.existsSync(staged.retainedTranscript.path)).toBe(true);
		expect(staged.transcript.kind).toBe("file");
		expect(staged.transcript.byteLength).toBe(storage.statSync(staged.sessionFile).size);
		expect(staged.transcript.sha256).toBe(
			sha256Bytes(storage.readFileRange(staged.sessionFile, 0, staged.transcript.byteLength)),
		);
		expect(staged.retainedTranscript.sha256).toBe(staged.transcript.sha256);
		expect(staged.retainedTranscript.path).not.toBe(staged.transcript.path);

		const dest = await SessionManager.open(staged.sessionFile, sessionDir, storage, { suppressBreadcrumb: true });
		try {
			const context = dest.buildSessionContext();
			const texts = context.messages.map(textOf).join("\n");
			expect(texts).toContain("PROTECTED_CONSTRAINT");
			expect(texts).toContain(QUEUED_USER);
			expect(texts).toContain(QUEUED_DEVELOPER);
			expect(texts).not.toContain(SOURCE_HISTORY);
			expect(context.messages.some(message => message.role === "user" && textOf(message) === QUEUED_USER)).toBe(
				true,
			);
			expect(
				context.messages.some(message => message.role === "developer" && textOf(message) === QUEUED_DEVELOPER),
			).toBe(true);
			expect(context.models.default).toBe("openai/scripted-dest-model");
			expect(context.thinkingLevel).toBe("high");
			expect(context.serviceTier?.openai).toBe("flex");
			expect(getLatestTodoPhasesFromEntries(dest.getBranch())).toEqual([
				{ name: "Tasks", tasks: [{ content: TODO_CONTENT, status: "pending" }] },
			]);
			expect(
				dest
					.getEntries()
					.some(
						entry =>
							entry.type === "custom" &&
							entry.customType === "omp-continuation" &&
							entry.data != null &&
							typeof entry.data === "object" &&
							"version" in entry.data &&
							entry.data.version === 1 &&
							"runId" in entry.data &&
							entry.data.runId === "run-stage-1" &&
							"planPath" in entry.data &&
							entry.data.planPath === "docs/plans/example.md",
					),
			).toBe(true);
			expect(dest.getContinuationServices()).toEqual([]);
			expect(await dest.consumeDraft()).toBe(DRAFT_TEXT);
		} finally {
			await dest.close();
			await source.close();
		}
	});

	for (const method of ["soft", "remote"] as const) {
		it(`retains protected inputs once across ${method} compaction and reload`, async () => {
			using temp = TempDir.createSync("continuation-compaction-context");
			const sessionDir = path.join(temp.path(), "sessions");
			const source = SessionManager.create(temp.path(), sessionDir);
			await source.ensureOnDisk();
			const staged = await source.stageContinuation(stageRequest(source, path.join(temp.path(), "retained.jsonl")));
			let dest = await SessionManager.open(staged.sessionFile, sessionDir);
			try {
				const developer = dest
					.getBranch()
					.find(entry => entry.type === "message" && entry.message.role === "developer");
				if (!developer) throw new Error("Missing staged developer input");
				dest.appendCompaction("Newer summary without protected facts", undefined, developer.id, 1000, {
					method,
					...(method === "remote"
						? {
								preserveData: {
									openaiRemoteCompaction: {
										provider: "openai",
										replacementHistory: [{ type: "compaction", encrypted_content: "synthetic" }],
									},
								},
								providerReplayThroughEntryId: developer.id,
							}
						: {}),
				});
				await dest.close();
				dest = await SessionManager.open(staged.sessionFile, sessionDir);
				const messages = dest.buildSessionContext().messages;
				for (const text of [BRIEFING_TEXT, QUEUED_USER, QUEUED_DEVELOPER]) {
					expect(messages.filter(message => textOf(message) === text)).toHaveLength(1);
				}
				expect(messages.some(message => textOf(message).includes(SOURCE_HISTORY))).toBe(false);
				dest.appendCustomEntry(CONTINUATION_PROTECTED_CONTEXT_TYPE, { version: 1, entryIds: ["missing-entry"] });
				expect(() => dest.buildSessionContext()).toThrow(/Protected continuation context is missing/);
			} finally {
				await dest.close();
				await source.close();
			}
		});
	}

	it("rejects assistant queued input and source todo contradictions before writing a stage", async () => {
		using tempDir = TempDir.createSync("@omp-stage-continuation-reject-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(cwd, { recursive: true });
		const source = SessionManager.create(cwd, sessionDir, new FileSessionStorage());
		source.appendMessage(makeAssistantMessage());
		source.appendCustomEntry("user_todo_edit", {
			phases: [{ name: "Tasks", tasks: [{ content: "source only", status: "pending" }] }],
		});
		await source.ensureOnDisk();
		const before = jsonlFiles(sessionDir);
		const evidencePath = path.join(tempDir.path(), "retained.jsonl");

		await expect(
			source.stageContinuation(
				stageRequest(source, evidencePath, {
					queuedMessages: [
						{
							role: "assistant",
							content: [{ type: "text", text: "not portable" }],
							timestamp: 4,
						} as unknown as ContinuationStageSessionRequest["queuedMessages"][number],
					],
				}),
			),
		).rejects.toThrow(/rejects queued assistant/);
		expect(jsonlFiles(sessionDir)).toEqual(before);
		expect(fs.existsSync(evidencePath)).toBe(false);

		await expect(source.stageContinuation(stageRequest(source, evidencePath))).rejects.toThrow(
			/todos contradict the canonical continuation projection/,
		);
		expect(jsonlFiles(sessionDir)).toEqual(before);
		expect(fs.existsSync(evidencePath)).toBe(false);
		await source.close();
	});

	it("fails closed for unsupported backends and fsync errors without a usable stage", async () => {
		using tempDir = TempDir.createSync("@omp-stage-continuation-failclosed-");
		const cwd = path.join(tempDir.path(), "project");
		const sessionDir = path.join(tempDir.path(), "sessions");
		fs.mkdirSync(cwd, { recursive: true });

		const memory = SessionManager.create(
			cwd,
			path.join(tempDir.path(), "memory-sessions"),
			new MemorySessionStorage(),
		);
		memory.appendMessage(makeAssistantMessage());
		await memory.ensureOnDisk();
		const memoryId = memory.getSessionId();
		const memoryCount = memory.getEntries().length;
		try {
			await memory.stageContinuation(stageRequest(memory, path.join(tempDir.path(), "memory-retained.jsonl")));
			throw new Error("memory staging should fail closed");
		} catch (error) {
			if (!(error instanceof ContinuationStoreError)) throw error;
			expect(error.code).toBe("unsupported-storage");
		}
		expect(memory.getSessionId()).toBe(memoryId);
		expect(memory.getEntries()).toHaveLength(memoryCount);
		await memory.close();

		class FailingSyncStorage extends FileSessionStorage {
			failSync = false;
			override syncFile(filePath: string): void {
				if (this.failSync) throw new Error("injected session fsync");
				super.syncFile(filePath);
			}
		}
		const storage = new FailingSyncStorage();
		const source = SessionManager.create(cwd, sessionDir, storage);
		source.appendMessage(makeAssistantMessage());
		await source.ensureOnDisk();
		const sourceFile = source.getSessionFile();
		if (!sourceFile) throw new Error("expected source session file");
		const before = jsonlFiles(sessionDir);
		storage.failSync = true;
		const evidencePath = path.join(tempDir.path(), "fsync-retained.jsonl");
		try {
			await source.stageContinuation(stageRequest(source, evidencePath));
			throw new Error("injected fsync should be visible");
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).toContain("injected session fsync");
		}
		expect(jsonlFiles(sessionDir)).toEqual(before);
		expect(fs.existsSync(evidencePath)).toBe(false);
		expect(source.getSessionFile()).toBe(sourceFile);
		await source.close();
	});
});
