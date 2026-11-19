import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import {
	type CanonicalPlanIdentityInput,
	type ContinuationActivation,
	type ContinuationDurableIo,
	type ContinuationOwnerRequest,
	type FileEvidenceRef,
	type PendingHandoff,
	ContinuationStoreError,
	archivedRunStatePath,
	checkpointPath,
	controlDirectory,
	createNodeDurableIo,
	inspectCommittedRunState,
	ownerLockTarget,
	planKeyFromRelativePath,
	resolveCanonicalPlanIdentity,
	SDD_GITIGNORE_RELATIVE,
	sha256Bytes,
	withContinuationOwner,
	writeImmutableJson,
} from "@oh-my-pi/pi-coding-agent/session/continuation-store";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	FileSessionStorage,
	MemorySessionStorage,
	UNSUPPORTED_INDEXED_CONTINUATION_DURABILITY,
	UNSUPPORTED_MEMORY_CONTINUATION_DURABILITY,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { __internalsForTesting, isEnoent, TempDir } from "@oh-my-pi/pi-utils";
import { makeAssistantMessage } from "./session-manager/helpers";

const { tryAcquireLock, getLockPath } = __internalsForTesting;
const FIXTURE = path.join(import.meta.dir, "fixtures/continuation/run-store-process.ts");
const tempDirs: TempDir[] = [];
interface SpawnedChild {
	kill(signal?: "SIGKILL"): void;
	exited: Promise<number>;
	exitCode: number | null;
	stderr: ReadableStream;
}

const children: SpawnedChild[] = [];

function tempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return fs.realpathSync(dir.path());
}

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
	}
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

async function seedWorktree(
	label: string,
	relativePlan = "docs/plans/example.md",
): Promise<{
	root: string;
	planPath: string;
	identity: CanonicalPlanIdentityInput;
	sessionFile: string;
}> {
	const root = tempDir(label);
	const planPath = path.join(root, relativePlan);
	fs.mkdirSync(path.dirname(planPath), { recursive: true });
	fs.writeFileSync(planPath, `# ${label}\n`);
	const sessionFile = path.join(root, "session.jsonl");
	fs.writeFileSync(sessionFile, "session\n");
	return { root, planPath, identity: { worktree: root, planPath }, sessionFile };
}

function enrollRequest(
	identity: CanonicalPlanIdentityInput,
	sessionFile: string,
	extra?: Partial<Extract<ContinuationOwnerRequest, { action: "enroll" }>["initial"]>,
): ContinuationOwnerRequest {
	return {
		action: "enroll",
		identity,
		initial: {
			runId: extra?.runId ?? "run-1",
			owner: {
				sessionId: extra?.owner?.sessionId ?? "sess-1",
				sessionFile: extra?.owner?.sessionFile ?? sessionFile,
			},
			intent: extra?.intent ?? { kind: "continue" },
			pendingEffects: extra?.pendingEffects,
			accounting: extra?.accounting,
			stop: extra?.stop,
			pendingHandoff: extra?.pendingHandoff,
		},
	};
}

function activationInput(
	sessionFile: string,
	transitionId: string,
	overrides: Partial<ContinuationActivation> = {},
): ContinuationActivation {
	return {
		expectedGeneration: 1,
		transitionId,
		handoffId: "handoff-1",
		session: { sessionId: "s2", sessionFile },
		frontierEvidence: [],
		checkpointDependencies: [],
		...overrides,
	};
}

async function writeStagedSuccessor(
	root: string,
	sessionId: string,
	contents = "staged-session\n",
): Promise<{
	sessionId: string;
	sessionFile: string;
	transcript: FileEvidenceRef;
	checkpoint: FileEvidenceRef;
}> {
	const sessionFile = path.join(root, `${sessionId}.jsonl`);
	fs.writeFileSync(sessionFile, contents);
	const bytes = fs.readFileSync(sessionFile);
	const transcript: FileEvidenceRef = {
		kind: "file",
		path: fs.realpathSync(sessionFile),
		byteLength: bytes.byteLength,
		sha256: sha256Bytes(bytes),
	};
	const checkpoint = await writeImmutableJson(path.join(root, "checkpoints", sessionId, "c1.json"), {
		kind: "checkpoint",
		sessionId,
	});
	return { sessionId, sessionFile, transcript, checkpoint };
}

function stagedHandoff(args: {
	generation: number;
	destination: {
		sessionId: string;
		sessionFile: string;
		transcript: FileEvidenceRef;
		checkpoint: FileEvidenceRef;
	};
	sourceSessionId?: string;
	sourceSessionFile?: string;
	id?: string;
	policyRevision?: string;
}): PendingHandoff {
	return {
		id: args.id ?? "handoff-1",
		phase: "staged",
		source: {
			sessionId: args.sourceSessionId ?? "sess-1",
			sessionFile: args.sourceSessionFile,
			generation: args.generation,
		},
		destination: args.destination,
		policyRevision: args.policyRevision ?? "pol-1",
	};
}

function ioWith(hooks: Partial<ContinuationDurableIo>): ContinuationDurableIo {
	return { ...createNodeDurableIo(), ...hooks };
}

function storeError(error: unknown): ContinuationStoreError {
	if (error instanceof ContinuationStoreError) return error;
	throw error;
}

function readFailedLockResult(filePath: string): { ok: boolean; message: string } {
	const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!parsed || typeof parsed !== "object") return { ok: true, message: "" };
	const ok = "ok" in parsed && parsed.ok === true;
	let message = "";
	if ("error" in parsed && parsed.error && typeof parsed.error === "object" && "message" in parsed.error) {
		const value = parsed.error.message;
		if (typeof value === "string") message = value;
	}
	return { ok, message };
}

async function waitForFile(filePath: string, child: SpawnedChild): Promise<void> {
	for (;;) {
		try {
			await fsp.access(filePath);
			return;
		} catch (error) {
			if (!isEnoent(error)) throw error;
			if (child.exitCode !== null) {
				const stderr = await new Response(child.stderr).text();
				throw new Error(`child exited before ${filePath} (${child.exitCode}): ${stderr}`);
			}
		}
	}
}

function spawnStoreProcess(config: unknown, env: Record<string, string> = {}): SpawnedChild {
	const configPath = path.join(tempDir("cont-cfg"), "config.json");
	fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
	const child = Bun.spawn([process.execPath, FIXTURE, configPath], {
		cwd: path.resolve(import.meta.dir, "../.."),
		env: { HOME: env.HOME ?? process.env.HOME ?? "", PATH: process.env.PATH ?? "", ...env },
		stdin: "ignore",
		stdout: "ignore",
		stderr: "pipe",
	});
	children.push(child);
	return child;
}

describe("session storage continuation durability capability", () => {
	it("file storage reports file-backed OS sync and memory/indexed reject it", () => {
		expect(new FileSessionStorage().continuationDurability()).toEqual({ kind: "file-backed-os-sync" });
		expect(new MemorySessionStorage().continuationDurability()).toEqual(UNSUPPORTED_MEMORY_CONTINUATION_DURABILITY);
		const indexed = new IndexedSessionStorage({
			init: async () => {},
			loadIndex: async () => [],
			readFull: async () => null,
			readSlices: async () => ["", ""],
			writeFull: async () => {},
			append: async () => {},
			updateSessionTitle: async () => {},
			truncate: async () => {},
			remove: async () => {},
			move: async () => {},
		} satisfies SessionStorageBackend);
		expect(indexed.continuationDurability()).toEqual(UNSUPPORTED_INDEXED_CONTINUATION_DURABILITY);
	});

	it("memory-backed SessionManager still appends when continuation is off, but the barrier fails closed", async () => {
		const cwd = tempDir("mem-sess");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), new MemorySessionStorage());
		manager.appendMessage(makeAssistantMessage());
		await manager.ensureOnDisk();
		expect(manager.getSessionFile()).toBeString();
		expect(manager.getContinuationEvidenceGeneration()).toBeGreaterThan(0);
		try {
			await manager.retainContinuationEvidence({
				destinationPath: path.join(cwd, "retained.bin"),
				byteLength: 1,
			});
			throw new Error("barrier should have rejected memory storage");
		} catch (error) {
			expect(storeError(error).code).toBe("unsupported-storage");
		}
	});
});

describe("canonical identity and gitignore", () => {
	it("uses the full relative path as the plan key, not the basename", async () => {
		const a = await seedWorktree("plan-a", "docs/plans/shared-name.md");
		const bPlan = path.join(a.root, "notes/shared-name.md");
		fs.mkdirSync(path.dirname(bPlan), { recursive: true });
		fs.writeFileSync(bPlan, "# other\n");
		expect(planKeyFromRelativePath("docs/plans/shared-name.md")).not.toBe(
			planKeyFromRelativePath("notes/shared-name.md"),
		);
		await withContinuationOwner(enrollRequest(a.identity, a.sessionFile), async owner => {
			expect(owner.getControlDir()).toBe(controlDirectory(owner.getIdentity()));
			expect(owner.getIdentity().relativePath).toBe("docs/plans/shared-name.md");
		});
		await withContinuationOwner(
			enrollRequest({ worktree: a.root, planPath: bPlan }, a.sessionFile, { runId: "run-b" }),
			async owner => {
				expect(owner.getIdentity().relativePath).toBe("notes/shared-name.md");
				expect(owner.getControlDir()).not.toBe(
					controlDirectory({
						root: owner.getIdentity().root,
						relativePath: "docs/plans/shared-name.md",
						pathSha256: planKeyFromRelativePath("docs/plans/shared-name.md"),
					}),
				);
			},
		);
	});

	it("derives one owner for the same plan launched from the repository root and a subdirectory", async () => {
		const seeded = await seedWorktree("nested-cwd", "subdir/plan.md");
		fs.mkdirSync(path.join(seeded.root, ".git", "refs", "heads"), { recursive: true });
		fs.mkdirSync(path.join(seeded.root, ".git", "objects"), { recursive: true });
		fs.writeFileSync(path.join(seeded.root, ".git", "HEAD"), "ref: refs/heads/main\n");
		fs.writeFileSync(
			path.join(seeded.root, ".git", "config"),
			"[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n",
		);
		const subdir = path.join(seeded.root, "subdir");
		const fromRoot = await resolveCanonicalPlanIdentity({ worktree: seeded.root, planPath: seeded.planPath });
		const fromSubdir = await resolveCanonicalPlanIdentity({ worktree: subdir, planPath: "plan.md" });
		expect(fromRoot).toEqual(fromSubdir);
		expect(fromRoot.root).toBe(seeded.root);
		expect(fromRoot.relativePath).toBe("subdir/plan.md");
		expect(controlDirectory(fromRoot)).toBe(controlDirectory(fromSubdir));
		await withContinuationOwner(
			enrollRequest({ worktree: seeded.root, planPath: seeded.planPath }, seeded.sessionFile),
			async owner => {
				expect(owner.getIdentity()).toEqual(fromRoot);
				expect(owner.getControlDir()).toBe(controlDirectory(fromRoot));
			},
		);
		await withContinuationOwner(
			{ action: "recover", identity: { worktree: subdir, planPath: "plan.md" } },
			async owner => {
				expect(owner.getState().run.id).toBe("run-1");
				expect(owner.getIdentity()).toEqual(fromRoot);
				expect(owner.getControlDir()).toBe(controlDirectory(fromRoot));
			},
		);
		try {
			await withContinuationOwner(
				enrollRequest({ worktree: subdir, planPath: "plan.md" }, seeded.sessionFile, { runId: "run-2" }),
				async () => {},
			);
			throw new Error("nested cwd should not enroll an independent run for the same plan");
		} catch (error) {
			expect(storeError(error).code).toBe("existing-authority");
		}
	});

	it("rejects a plan path that is a symlink", async () => {
		const seeded = await seedWorktree("symlink-plan");
		const linked = path.join(seeded.root, "docs/plans/linked.md");
		fs.symlinkSync(seeded.planPath, linked);
		try {
			await withContinuationOwner(
				enrollRequest({ worktree: seeded.root, planPath: linked }, seeded.sessionFile),
				async () => {},
			);
			throw new Error("symlink plan should be rejected");
		} catch (error) {
			expect(storeError(error).code).toBe("symlink-ambiguous");
		}
	});

	it("establishes and verifies the self-ignoring sdd gitignore before publishing", async () => {
		const seeded = await seedWorktree("gitignore");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			const gi = path.join(owner.getIdentity().root, SDD_GITIGNORE_RELATIVE);
			expect(fs.readFileSync(gi, "utf8").trim()).toBe("*");
			expect(fs.existsSync(path.join(owner.getControlDir(), "state.json"))).toBe(true);
		});
		fs.writeFileSync(path.join(seeded.root, SDD_GITIGNORE_RELATIVE), "state.json\n");
		try {
			await withContinuationOwner({ action: "recover", identity: seeded.identity }, async () => {});
			throw new Error("modified gitignore should block recovery publication");
		} catch (error) {
			expect(storeError(error).code).toBe("gitignore-unverified");
		}
	});
});

describe("enrollment and recovery authority", () => {
	it("treats missing and corrupt state as attention, not a replacement run", async () => {
		const seeded = await seedWorktree("missing");
		try {
			await withContinuationOwner({ action: "recover", identity: seeded.identity }, async () => {});
			throw new Error("missing state should stop");
		} catch (error) {
			expect(storeError(error).code).toBe("missing-state");
		}
		const torn = await seedWorktree("torn");
		await withContinuationOwner(enrollRequest(torn.identity, torn.sessionFile), async owner => {
			fs.mkdirSync(owner.getControlDir(), { recursive: true });
		});
		const controlDir = controlDirectory((await inspectCommittedRunState(torn.identity)).identity);
		fs.unlinkSync(path.join(controlDir, "state.json"));
		fs.writeFileSync(path.join(controlDir, ".state.json.tmp"), "{");
		try {
			await withContinuationOwner({ action: "recover", identity: torn.identity }, async () => {});
			throw new Error("missing state should stop");
		} catch (error) {
			expect(storeError(error).code).toBe("missing-state");
		}

		const corrupt = await seedWorktree("corrupt");
		await withContinuationOwner(enrollRequest(corrupt.identity, corrupt.sessionFile), async () => {});
		const corruptDir = (await inspectCommittedRunState(corrupt.identity)).controlDir;
		fs.writeFileSync(path.join(corruptDir, "state.json"), "not-json");
		try {
			await withContinuationOwner({ action: "recover", identity: corrupt.identity }, async () => {});
			throw new Error("corrupt state should stop");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}
	});

	it("refuses to overwrite an unexpected existing authority on enroll", async () => {
		const seeded = await seedWorktree("existing");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
		try {
			await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
			throw new Error("second enroll should fail");
		} catch (error) {
			expect(storeError(error).code).toBe("existing-authority");
		}
	});

	it("archives a verified terminal run before enrolling a different run and keeps prior evidence", async () => {
		const seeded = await seedWorktree("terminal-cutover");
		const evidencePath = path.join(seeded.root, "kept.bin");
		fs.writeFileSync(evidencePath, "keep-me");
		const ref: FileEvidenceRef = {
			kind: "file",
			path: fs.realpathSync(evidencePath),
			byteLength: 7,
			sha256: sha256Bytes("keep-me"),
		};
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			await owner.commit({
				expectedGeneration: 1,
				transitionId: "term",
				immutableDependencies: [ref],
				patch: {
					runTerminal: true,
					frontier: { lastCommittedTransitionId: null, lastCommittedEventId: null, evidence: [ref] },
				},
			});
		});
		try {
			await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
			throw new Error("same-run enroll after terminal should fail");
		} catch (error) {
			expect(storeError(error).code).toBe("existing-authority");
		}
		const before = await inspectCommittedRunState(seeded.identity);
		const archivePath = archivedRunStatePath(before.controlDir, "run-1");
		await withContinuationOwner(
			enrollRequest(seeded.identity, seeded.sessionFile, {
				runId: "run-2",
				owner: { sessionId: "sess-2", sessionFile: seeded.sessionFile },
			}),
			async owner => {
				expect(owner.getState().run.id).toBe("run-2");
				expect(owner.getState().owner.generation).toBe(1);
				expect(owner.getState().run.terminal).toBe(false);
			},
		);
		expect(fs.existsSync(archivePath)).toBe(true);
		expect(fs.existsSync(evidencePath)).toBe(true);
		const archived = JSON.parse(fs.readFileSync(archivePath, "utf8")) as { run: { id: string; terminal: boolean } };
		expect(archived.run.id).toBe("run-1");
		expect(archived.run.terminal).toBe(true);
		const live = await inspectCommittedRunState(seeded.identity);
		expect(live.state.run.id).toBe("run-2");
		expect(fs.existsSync(path.join(before.controlDir, "state.json"))).toBe(true);
	});

	it("rejects a different-run enroll while the committed run is live or unsettled", async () => {
		const live = await seedWorktree("enroll-live");
		await withContinuationOwner(enrollRequest(live.identity, live.sessionFile), async () => {});
		try {
			await withContinuationOwner(
				enrollRequest(live.identity, live.sessionFile, { runId: "run-2" }),
				async () => {},
			);
			throw new Error("live different-run enroll should fail");
		} catch (error) {
			expect(storeError(error).code).toBe("existing-authority");
		}

		const unsettled = await seedWorktree("enroll-unsettled");
		await withContinuationOwner(
			enrollRequest(unsettled.identity, unsettled.sessionFile, {
				pendingEffects: [{ id: "fx-1", kind: "worker", unresolved: true, identity: "worker-a" }],
				accounting: {
					workers: [{ identity: "worker-a", status: "live" }],
					sessions: [{ sessionId: "sess-1", sessionFile: unsettled.sessionFile }],
				},
			}),
			async owner => {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "term-unsettled",
					patch: { runTerminal: true },
				});
			},
		);
		try {
			await withContinuationOwner(
				enrollRequest(unsettled.identity, unsettled.sessionFile, { runId: "run-2" }),
				async () => {},
			);
			throw new Error("unsettled terminal enroll should fail");
		} catch (error) {
			expect(storeError(error).code).toBe("unresolved-effects");
		}
	});

	it("rejects stale generations and contradictory duplicate transitions, and recognizes committed ids", async () => {
		const seeded = await seedWorktree("transitions");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			const first = await owner.commit({
				expectedGeneration: 1,
				transitionId: "t1",
				eventId: "e1",
				patch: { intent: { kind: "pause", reason: "wait" } },
			});
			expect(first.frontier.lastCommittedTransitionId).toBe("t1");
			expect(first.intent).toEqual({ kind: "pause", reason: "wait" });
			const again = await owner.commit({
				expectedGeneration: 1,
				transitionId: "t1",
				eventId: "e1",
				patch: { intent: { kind: "pause", reason: "wait" } },
			});
			expect(again.frontier.lastCommittedTransitionId).toBe("t1");
			try {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "t1",
					eventId: "e1",
					patch: { intent: { kind: "continue" } },
				});
				throw new Error("contradictory duplicate should fail");
			} catch (error) {
				expect(storeError(error).code).toBe("contradictory-duplicate");
			}
			try {
				await owner.commit({
					expectedGeneration: 99,
					transitionId: "t2",
					patch: { intent: { kind: "continue" } },
				});
				throw new Error("stale generation should fail");
			} catch (error) {
				expect(storeError(error).code).toBe("stale-generation");
			}
			expect(owner.getState().frontier.lastCommittedTransitionId).toBe("t1");
		});
	});

	it("keeps live workers accounted for and refuses blind replacement dispatch", async () => {
		const seeded = await seedWorktree("workers");
		await withContinuationOwner(
			enrollRequest(seeded.identity, seeded.sessionFile, {
				pendingEffects: [{ id: "fx-1", kind: "worker", unresolved: true, identity: "worker-a" }],
				accounting: {
					workers: [{ identity: "worker-a", status: "live", launchedAt: "now" }],
					sessions: [{ sessionId: "sess-1", sessionFile: seeded.sessionFile }],
				},
			}),
			async owner => {
				expect(owner.canAdmitWork()).toBe(false);
				try {
					await owner.activateOwner(
						activationInput(seeded.sessionFile, "activate-sess-2", {
							session: { sessionId: "sess-2", sessionFile: seeded.sessionFile },
						}),
					);
					throw new Error("activate should refuse while a worker is live");
				} catch (error) {
					expect(storeError(error).code).toBe("unresolved-effects");
				}
				expect(owner.getState().owner.generation).toBe(1);
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "settle-worker",
					patch: {
						pendingEffects: [],
						accounting: {
							workers: [{ identity: "worker-a", status: "settled" }],
							sessions: owner.getState().accounting.sessions,
						},
					},
				});
				expect(owner.canAdmitWork()).toBe(true);
				const dest = await writeStagedSuccessor(seeded.root, "sess-2");
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "stage-handoff",
					patch: {
						pendingHandoff: stagedHandoff({
							generation: 1,
							sourceSessionFile: seeded.sessionFile,
							destination: dest,
						}),
					},
				});
				expect(owner.canAdmitWork()).toBe(false);
				const next = await owner.activateOwner(
					activationInput(dest.sessionFile, "activate-sess-2-ok", {
						session: { sessionId: dest.sessionId, sessionFile: dest.sessionFile },
						frontierEvidence: [dest.checkpoint],
						checkpointDependencies: [dest.checkpoint],
						expectedFrontier: owner.getState().frontier,
						expectedPolicyRevision: "pol-1",
					}),
				);
				expect(next.owner.generation).toBe(2);
				expect(next.owner.sessionId).toBe("sess-2");
				expect(next.run.id).toBe("run-1");
				expect(next.pendingHandoff).toBeNull();
				expect(next.intent).toEqual({ kind: "continue" });
				expect(next.accounting.workers).toEqual([{ identity: "worker-a", status: "settled" }]);
				expect(next.frontier.evidence).toEqual([dest.checkpoint]);
			},
		);
	});
});

describe("synchronized publication failures", () => {
	it("does not create authority when exclusive temp fsync fails", async () => {
		const seeded = await seedWorktree("fsync-fail");
		const io = ioWith({
			async fsyncFile(filePath) {
				if (filePath.includes(".state.json.") && filePath.endsWith(".tmp")) throw new Error("injected temp fsync");
				await createNodeDurableIo().fsyncFile(filePath);
			},
		});
		try {
			await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {}, { io });
			throw new Error("enroll should fail closed");
		} catch (error) {
			expect(storeError(error).code).toBe("publication-failed");
		}
		try {
			await inspectCommittedRunState(seeded.identity);
			throw new Error("no committed authority should exist");
		} catch (error) {
			expect(storeError(error).code).toBe("missing-state");
		}
	});

	it("refuses initial enroll when exclusive link reports EEXIST", async () => {
		const seeded = await seedWorktree("link-exist");
		const io = ioWith({
			async link() {
				throw Object.assign(new Error("injected EEXIST"), { code: "EEXIST" });
			},
		});
		try {
			await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {}, { io });
			throw new Error("exclusive link collision should refuse");
		} catch (error) {
			expect(storeError(error).code).toBe("existing-authority");
		}
	});

	it("latches the owner after a pre-rename commit failure and rejects later commits", async () => {
		const seeded = await seedWorktree("commit-rename-fail");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
		const io = ioWith({
			async rename() {
				throw new Error("injected rename");
			},
		});
		await withContinuationOwner(
			{ action: "recover", identity: seeded.identity },
			async owner => {
				try {
					await owner.commit({
						expectedGeneration: 1,
						transitionId: "t-rename",
						patch: { intent: { kind: "pause", reason: "x" } },
					});
					throw new Error("rename failure should be visible");
				} catch (error) {
					expect(storeError(error).code).toBe("publication-failed");
				}
				expect(owner.getState().frontier.lastCommittedTransitionId).toBeNull();
				try {
					await owner.commit({
						expectedGeneration: 1,
						transitionId: "t-rename-2",
						patch: { intent: { kind: "continue" } },
					});
					throw new Error("latched owner must reject later commits");
				} catch (error) {
					expect(storeError(error).code).toBe("publication-failed");
				}
				expect(owner.canAdmitWork()).toBe(false);
			},
			{ io },
		);
	});

	it("preserves rejection after rename survives dir fsync failure and latches later commits", async () => {
		const seeded = await seedWorktree("dirsync-fail");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
		let renamed = false;
		const io = ioWith({
			async rename(from, to) {
				await createNodeDurableIo().rename(from, to);
				renamed = true;
			},
			async fsyncDir(dirPath: string) {
				if (renamed) throw new Error("injected dir fsync");
				await createNodeDurableIo().fsyncDir(dirPath);
			},
		});
		await withContinuationOwner(
			{ action: "recover", identity: seeded.identity },
			async owner => {
				try {
					await owner.commit({
						expectedGeneration: 1,
						transitionId: "t-dirsync",
						patch: { intent: { kind: "pause", reason: "after-rename" } },
					});
					throw new Error("dir fsync failure should be visible");
				} catch (error) {
					expect(storeError(error).code).toBe("publication-failed");
				}
				try {
					await owner.commit({
						expectedGeneration: 1,
						transitionId: "t-dirsync-2",
						patch: { intent: { kind: "continue" } },
					});
					throw new Error("latched owner must reject later commits");
				} catch (error) {
					expect(storeError(error).code).toBe("publication-failed");
				}
			},
			{ io },
		);
		const inspected = await inspectCommittedRunState(seeded.identity);
		expect(inspected.state.frontier.lastCommittedTransitionId).toBe("t-dirsync");
	});

	it("latches the owner when evidence sync fails before publication", async () => {
		const seeded = await seedWorktree("evidence-sync-fail");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
		await withContinuationOwner({ action: "recover", identity: seeded.identity }, async owner => {
			try {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "t-ev",
					immutableDependencies: [
						{
							kind: "file",
							path: path.join(seeded.root, "missing-evidence.bin"),
							byteLength: 4,
							sha256: "a".repeat(64),
						},
					],
					patch: { intent: { kind: "continue" } },
				});
				throw new Error("missing evidence should fail");
			} catch (error) {
				expect(storeError(error).code).toBe("publication-failed");
			}
			try {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "t-ev-2",
					patch: { intent: { kind: "continue" } },
				});
				throw new Error("latched owner must reject later commits");
			} catch (error) {
				expect(storeError(error).code).toBe("publication-failed");
			}
		});
	});
});

describe("native owner lock", () => {
	it("releases ownership when the controller dies, but not when an unrelated worker dies", async () => {
		const seeded = await seedWorktree("lock-death");
		const readyPath = path.join(seeded.root, "ready.json");
		const resultPath = path.join(seeded.root, "result.json");
		const holder = spawnStoreProcess({
			mode: "hold-owner",
			request: enrollRequest(seeded.identity, seeded.sessionFile),
			readyPath,
			resultPath,
		});
		await waitForFile(readyPath, holder);
		const controlDir = (await inspectCommittedRunState(seeded.identity)).controlDir;
		const lockPath = getLockPath(ownerLockTarget(controlDir));
		expect(tryAcquireLock(lockPath)).toBeNull();

		const workerReady = path.join(seeded.root, "worker-ready.json");
		const worker = spawnStoreProcess({
			mode: "hold-worker",
			readyPath: workerReady,
			resultPath: path.join(seeded.root, "worker-result.json"),
		});
		await waitForFile(workerReady, worker);
		worker.kill("SIGKILL");
		expect(await worker.exited).not.toBe(0);
		expect(tryAcquireLock(lockPath)).toBeNull();

		holder.kill("SIGKILL");
		expect(await holder.exited).not.toBe(0);
		await withContinuationOwner({ action: "recover", identity: seeded.identity }, async owner => {
			expect(owner.getState().run.id).toBe("run-1");
			const lockScope = owner.getLockScope();
			expect(lockScope.crossNamespaceCertified).toBe(false);
			if (process.platform === "linux") {
				expect(lockScope.kind).toBe("linux-abstract-socket");
				if (lockScope.kind === "linux-abstract-socket") {
					expect(lockScope.limitation).toContain("namespace");
				}
			} else if (process.platform === "win32") {
				expect(lockScope.kind).toBe("windows-named-mutex");
			} else {
				expect(lockScope.kind).toBe("flock");
			}
		});
	}, 15_000);

	it("excludes a competing launcher even when OMP homes differ", async () => {
		const seeded = await seedWorktree("homes");
		const homeA = tempDir("home-a");
		const homeB = tempDir("home-b");
		const readyPath = path.join(seeded.root, "a-ready.json");
		const holder = spawnStoreProcess(
			{
				mode: "hold-owner",
				request: enrollRequest(seeded.identity, seeded.sessionFile),
				readyPath,
				resultPath: path.join(seeded.root, "a-result.json"),
			},
			{ HOME: homeA },
		);
		await waitForFile(readyPath, holder);
		const challengerResult = path.join(seeded.root, "b-result.json");
		const challenger = spawnStoreProcess(
			{
				mode: "try-owner",
				request: { action: "recover", identity: seeded.identity },
				readyPath: path.join(seeded.root, "b-ready.json"),
				resultPath: challengerResult,
				lockRetries: 1,
			},
			{ HOME: homeB },
		);
		expect(await challenger.exited).not.toBe(0);
		const result = readFailedLockResult(challengerResult);
		expect(result.ok).toBe(false);
		expect(result.message).toContain("Failed to acquire lock");
		const inspected = await inspectCommittedRunState(seeded.identity);
		expect(inspected.state.owner.generation).toBe(1);
		holder.kill("SIGKILL");
		await holder.exited;
	}, 15_000);

	it("preserves surviving worker accounting after controller death so inspection cannot admit replacement work", async () => {
		const seeded = await seedWorktree("survive");
		const readyPath = path.join(seeded.root, "ready.json");
		const holder = spawnStoreProcess({
			mode: "hold-owner",
			request: enrollRequest(seeded.identity, seeded.sessionFile, {
				pendingEffects: [{ id: "fx-live", kind: "worker", unresolved: true, identity: "worker-z" }],
				accounting: {
					workers: [{ identity: "worker-z", status: "live" }],
					sessions: [{ sessionId: "sess-1", sessionFile: seeded.sessionFile }],
				},
			}),
			readyPath,
			resultPath: path.join(seeded.root, "result.json"),
		});
		await waitForFile(readyPath, holder);
		holder.kill("SIGKILL");
		await holder.exited;
		const inspected = await inspectCommittedRunState(seeded.identity);
		expect(inspected.state.accounting.workers).toEqual([{ identity: "worker-z", status: "live" }]);
		await withContinuationOwner({ action: "recover", identity: seeded.identity }, async owner => {
			expect(owner.canAdmitWork()).toBe(false);
			try {
				await owner.activateOwner(
					activationInput(seeded.sessionFile, "activate-replacement", {
						session: { sessionId: "replacement", sessionFile: seeded.sessionFile },
					}),
				);
				throw new Error("replacement dispatch should be refused");
			} catch (error) {
				expect(storeError(error).code).toBe("unresolved-effects");
			}
		});
	}, 15_000);
});

describe("SessionManager file-backed recovery barrier", () => {
	it("retains queued messages without a caller flush or an out-of-lock size observation", async () => {
		const cwd = tempDir("barrier-queued");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), new FileSessionStorage());
		manager.appendMessage(makeAssistantMessage());
		await manager.ensureOnDisk();
		manager.appendMessage({
			...makeAssistantMessage(),
			content: [{ type: "text", text: "QUEUED_RECOVERY_OBLIGATION" }],
		});
		const retained = await manager.retainContinuationEvidence({
			destinationPath: path.join(cwd, "retained", "nested", "queued.jsonl"),
		});
		const reopened = await SessionManager.open(retained.evidence.path);
		try {
			expect(
				reopened
					.getEntries()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some(
								content => content.type === "text" && content.text === "QUEUED_RECOVERY_OBLIGATION",
							),
					),
			).toBe(true);
		} finally {
			await reopened.close();
			await manager.close();
		}
	});

	it("keeps acknowledged prefix bytes valid across append, title rewrite, full rewrite and relocation", async () => {
		const cwd = tempDir("barrier-cwd");
		const sessionDir = path.join(cwd, "sessions");
		const retainedDir = path.join(cwd, "retained");
		fs.mkdirSync(retainedDir, { recursive: true });
		const storage = new FileSessionStorage();
		const manager = SessionManager.create(cwd, sessionDir, storage);
		manager.appendMessage(makeAssistantMessage());
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected session file");
		const initialSize = storage.statSync(sessionFile).size;
		const firstPath = path.join(retainedDir, "gen-first.bin");
		const first = await manager.retainContinuationEvidence({ destinationPath: firstPath, byteLength: initialSize });
		expect(first.evidence.byteLength).toBe(initialSize);
		expect(first.metrics.bytesCopied).toBe(initialSize);

		manager.appendMessage(makeAssistantMessage());
		await manager.flush();
		const afterAppend = storage.statSync(sessionFile).size;
		const extended = await manager.retainContinuationEvidence({
			destinationPath: firstPath,
			byteLength: afterAppend,
			previous: { ...first.cursor, path: firstPath, sha256: first.evidence.sha256 },
		});
		expect(extended.metrics.bytesCopied).toBe(afterAppend - initialSize);
		expect(extended.metrics.bytesCopied).toBeLessThan(afterAppend);
		expect(sha256Bytes(storage.readFileRange(firstPath, 0, initialSize))).toBe(first.evidence.sha256);

		const liveAfterTitleWouldChange = storage.readFileRange(sessionFile, 0, 256);
		await manager.setSessionName("continuation-title", "user");
		const liveTitlePrefix = storage.readFileRange(sessionFile, 0, 256);
		expect(sha256Bytes(liveTitlePrefix)).not.toBe(sha256Bytes(liveAfterTitleWouldChange));
		expect(sha256Bytes(storage.readFileRange(firstPath, 0, initialSize))).toBe(first.evidence.sha256);

		const secondPath = path.join(retainedDir, "gen-title.bin");
		const afterTitleSize = storage.statSync(sessionFile).size;
		const titled = await manager.retainContinuationEvidence({
			destinationPath: secondPath,
			byteLength: afterTitleSize,
		});
		expect(titled.cursor.generation).toBeGreaterThan(first.cursor.generation);
		expect(sha256Bytes(storage.readFileRange(firstPath, 0, initialSize))).toBe(first.evidence.sha256);

		await manager.rewriteEntries();
		const thirdPath = path.join(retainedDir, "gen-rewrite.bin");
		const rewritten = await manager.retainContinuationEvidence({
			destinationPath: thirdPath,
			byteLength: storage.statSync(sessionFile).size,
		});
		expect(rewritten.cursor.generation).toBeGreaterThan(titled.cursor.generation);
		expect(sha256Bytes(storage.readFileRange(firstPath, 0, initialSize))).toBe(first.evidence.sha256);
		expect(sha256Bytes(storage.readFileRange(secondPath, 0, titled.evidence.byteLength))).toBe(
			titled.evidence.sha256,
		);

		const destCwd = tempDir("barrier-moved");
		await manager.moveTo(destCwd);
		expect(sha256Bytes(storage.readFileRange(firstPath, 0, initialSize))).toBe(first.evidence.sha256);
		expect(manager.getSessionFile()).not.toBe(sessionFile);
	});

	it("fails visibly when file sync is injected and refuses to clobber retained bytes after a title change", async () => {
		const cwd = tempDir("barrier-fail");
		class FailingSyncStorage extends FileSessionStorage {
			failSync = false;
			override syncFile(filePath: string): void {
				if (this.failSync) throw new Error("injected session fsync");
				super.syncFile(filePath);
			}
		}
		const storage = new FailingSyncStorage();
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"), storage);
		manager.appendMessage(makeAssistantMessage());
		await manager.ensureOnDisk();
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("expected session file");
		storage.failSync = true;
		try {
			await manager.retainContinuationEvidence({
				destinationPath: path.join(cwd, "retained.bin"),
				byteLength: storage.statSync(sessionFile).size,
			});
			throw new Error("injected fsync should be visible");
		} catch (error) {
			expect(error instanceof Error ? error.message : String(error)).toContain("injected session fsync");
		}
		storage.failSync = false;
		const retained = path.join(cwd, "retained.bin");
		const first = await manager.retainContinuationEvidence({
			destinationPath: retained,
			byteLength: storage.statSync(sessionFile).size,
		});
		await manager.setSessionName("new-title", "user");
		try {
			await manager.retainContinuationEvidence({
				destinationPath: retained,
				byteLength: storage.statSync(sessionFile).size,
				previous: { ...first.cursor, path: retained, sha256: first.evidence.sha256 },
			});
			throw new Error("title change must not overwrite retained evidence");
		} catch (error) {
			expect(storeError(error).code).toBe("overwrite-retained-evidence");
		}
		expect(sha256Bytes(storage.readFileRange(retained, 0, first.evidence.byteLength))).toBe(first.evidence.sha256);
	});
});

describe("immutable checkpoint publication", () => {
	it("syncs checkpoint bytes before they can be referenced and refuses overwrite", async () => {
		const root = tempDir("ckpt");
		const filePath = path.join(root, "checkpoints", "run-1", "c1.json");
		const ref = await writeImmutableJson(filePath, { kind: "checkpoint", n: 1 });
		expect(sha256Bytes(fs.readFileSync(filePath).subarray(0, ref.byteLength))).toBe(ref.sha256);
		try {
			await writeImmutableJson(filePath, { kind: "checkpoint", n: 2 });
			throw new Error("checkpoint overwrite should fail");
		} catch (error) {
			expect(storeError(error).code).toBe("existing-authority");
		}
		expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({ kind: "checkpoint", n: 1 });
	});

	it("does not acknowledge bytes when a newly created ancestor cannot be synchronized", async () => {
		const root = tempDir("ckpt-ancestor");
		const parent = path.join(root, "checkpoints");
		const filePath = path.join(parent, "run-1", "c1.json");
		const realIo = createNodeDurableIo();
		await expect(
			writeImmutableJson(
				filePath,
				{ retained: true },
				ioWith({
					async fsyncDir(dir) {
						if (dir === parent) throw new Error("injected ancestor fsync failure");
						await realIo.fsyncDir(dir);
					},
				}),
			),
		).rejects.toThrow("injected ancestor fsync failure");
	});

	it("rejects a symlinked checkpoint directory without writing outside the worktree", async () => {
		const root = tempDir("ckpt-symlink");
		const outside = tempDir("ckpt-outside");
		fs.symlinkSync(outside, path.join(root, "checkpoints"));
		await expect(writeImmutableJson(path.join(root, "checkpoints", "c1.json"), { retained: true })).rejects.toThrow(
			"Unexpected symlink",
		);
		expect(fs.existsSync(path.join(outside, "c1.json"))).toBe(false);
	});

	it("rejects path-bearing checkpoint identities", () => {
		expect(() => checkpointPath("/control", "../outside", "checkpoint")).toThrow("safe path segments");
		expect(() => checkpointPath("/control", "run", "../outside")).toThrow("safe path segments");
	});
});

describe("strict recovery validation", () => {
	async function enrolledState(label: string) {
		const seeded = await seedWorktree(label);
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
		const inspected = await inspectCommittedRunState(seeded.identity);
		return { seeded, inspected };
	}

	it("rejects missing pendingEffects or accounting instead of defaulting them", async () => {
		const missingEffects = await enrolledState("strict-effects");
		const raw = JSON.parse(
			fs.readFileSync(path.join(missingEffects.inspected.controlDir, "state.json"), "utf8"),
		) as Record<string, unknown>;
		delete raw.pendingEffects;
		fs.writeFileSync(path.join(missingEffects.inspected.controlDir, "state.json"), `${JSON.stringify(raw)}\n`);
		try {
			await withContinuationOwner({ action: "recover", identity: missingEffects.seeded.identity }, async () => {});
			throw new Error("missing pendingEffects should be corrupt");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}

		const missingAccounting = await enrolledState("strict-accounting");
		const rawAccounting = JSON.parse(
			fs.readFileSync(path.join(missingAccounting.inspected.controlDir, "state.json"), "utf8"),
		) as Record<string, unknown>;
		delete rawAccounting.accounting;
		fs.writeFileSync(
			path.join(missingAccounting.inspected.controlDir, "state.json"),
			`${JSON.stringify(rawAccounting)}\n`,
		);
		try {
			await withContinuationOwner(
				{ action: "recover", identity: missingAccounting.seeded.identity },
				async () => {},
			);
			throw new Error("missing accounting should be corrupt");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}
	});

	it("rejects invalid intent, worker status, and generation", async () => {
		const intentCase = await enrolledState("strict-intent");
		const intentRaw = JSON.parse(
			fs.readFileSync(path.join(intentCase.inspected.controlDir, "state.json"), "utf8"),
		) as {
			intent: { kind: string };
		};
		intentRaw.intent.kind = "unknown";
		fs.writeFileSync(path.join(intentCase.inspected.controlDir, "state.json"), `${JSON.stringify(intentRaw)}\n`);
		try {
			await withContinuationOwner({ action: "recover", identity: intentCase.seeded.identity }, async () => {});
			throw new Error("invalid intent should be corrupt");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}

		const statusCase = await enrolledState("strict-status");
		const statusRaw = JSON.parse(
			fs.readFileSync(path.join(statusCase.inspected.controlDir, "state.json"), "utf8"),
		) as Record<string, unknown>;
		statusRaw.accounting = { workers: [{ identity: "w", status: "ghost" }], sessions: [] };
		fs.writeFileSync(path.join(statusCase.inspected.controlDir, "state.json"), `${JSON.stringify(statusRaw)}\n`);
		try {
			await withContinuationOwner({ action: "recover", identity: statusCase.seeded.identity }, async () => {});
			throw new Error("invalid worker status should be corrupt");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}

		const generationCase = await enrolledState("strict-generation");
		const generationRaw = JSON.parse(
			fs.readFileSync(path.join(generationCase.inspected.controlDir, "state.json"), "utf8"),
		) as { owner: { generation: number } };
		generationRaw.owner.generation = 0;
		fs.writeFileSync(
			path.join(generationCase.inspected.controlDir, "state.json"),
			`${JSON.stringify(generationRaw)}\n`,
		);
		try {
			await withContinuationOwner({ action: "recover", identity: generationCase.seeded.identity }, async () => {});
			throw new Error("invalid generation should be corrupt");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}
	});

	it("refuses recovery when committed evidence is missing or changed", async () => {
		const seeded = await seedWorktree("evidence-verify");
		const evidencePath = path.join(seeded.root, "kept.bin");
		fs.writeFileSync(evidencePath, "abcd");
		const ref = {
			kind: "file" as const,
			path: fs.realpathSync(evidencePath),
			byteLength: 4,
			sha256: sha256Bytes("abcd"),
		};
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			await owner.commit({
				expectedGeneration: 1,
				transitionId: "keep-ev",
				immutableDependencies: [ref],
				patch: {
					frontier: {
						lastCommittedTransitionId: null,
						lastCommittedEventId: null,
						evidence: [ref],
					},
				},
			});
		});
		fs.writeFileSync(evidencePath, "zzzz");
		try {
			await withContinuationOwner({ action: "recover", identity: seeded.identity }, async () => {});
			throw new Error("changed evidence should block recovery");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}
		fs.unlinkSync(evidencePath);
		try {
			await withContinuationOwner({ action: "recover", identity: seeded.identity }, async () => {});
			throw new Error("missing evidence should block recovery");
		} catch (error) {
			expect(storeError(error).code).toBe("corrupt-state");
		}
	});
});

describe("recovery admission and activation", () => {
	it("blocks activation on pause, stop intent, operator stop, pending handoff, and terminal runs", async () => {
		const pause = await seedWorktree("admit-pause");
		await withContinuationOwner(
			enrollRequest(pause.identity, pause.sessionFile, { intent: { kind: "pause", reason: "wait" } }),
			async owner => {
				expect(owner.canAdmitWork()).toBe(false);
				try {
					await owner.activateOwner(activationInput(pause.sessionFile, "act-pause"));
					throw new Error("pause should block activation");
				} catch (error) {
					expect(storeError(error).code).toBe("admission-blocked");
				}
			},
		);

		const stopIntent = await seedWorktree("admit-stop-intent");
		await withContinuationOwner(
			enrollRequest(stopIntent.identity, stopIntent.sessionFile, { intent: { kind: "stop", reason: "halt" } }),
			async owner => {
				expect(owner.canAdmitWork()).toBe(false);
				try {
					await owner.activateOwner(activationInput(stopIntent.sessionFile, "act-stop-intent"));
					throw new Error("stop intent should block activation");
				} catch (error) {
					expect(storeError(error).code).toBe("admission-blocked");
				}
			},
		);

		const operatorStop = await seedWorktree("admit-operator-stop");
		await withContinuationOwner(
			enrollRequest(operatorStop.identity, operatorStop.sessionFile, {
				stop: { reason: "operator", kind: "operator", at: "now" },
			}),
			async owner => {
				expect(owner.canAdmitWork()).toBe(false);
				try {
					await owner.activateOwner(activationInput(operatorStop.sessionFile, "act-operator"));
					throw new Error("operator stop should block activation");
				} catch (error) {
					expect(storeError(error).code).toBe("admission-blocked");
				}
			},
		);

		const handoff = await seedWorktree("admit-handoff");
		await withContinuationOwner(
			enrollRequest(handoff.identity, handoff.sessionFile, {
				pendingHandoff: {
					id: "handoff-1",
					phase: "preparing",
					source: { sessionId: "sess-1", generation: 1 },
					destination: {},
					policyRevision: "pol-1",
				},
			}),
			async owner => {
				expect(owner.canAdmitWork()).toBe(false);
				try {
					await owner.activateOwner(activationInput(handoff.sessionFile, "act-handoff"));
					throw new Error("pending handoff should block activation");
				} catch (error) {
					expect(storeError(error).code).toBe("handoff-not-staged");
				}
			},
		);

		const terminal = await seedWorktree("admit-terminal");
		await withContinuationOwner(enrollRequest(terminal.identity, terminal.sessionFile), async owner => {
			await owner.commit({
				expectedGeneration: 1,
				transitionId: "term",
				patch: { runTerminal: true },
			});
			expect(owner.canAdmitWork()).toBe(false);
			try {
				await owner.activateOwner(activationInput(terminal.sessionFile, "act-term"));
				throw new Error("terminal run should block activation");
			} catch (error) {
				expect(storeError(error).code).toBe("run-terminal");
			}
		});
	});

	it("activates only as a serialized transition with expected generation, id, and checkpoint bytes", async () => {
		const seeded = await seedWorktree("activate-ckpt");
		const dest = await writeStagedSuccessor(seeded.root, "s2");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			try {
				await owner.activateOwner(
					activationInput(dest.sessionFile, "act-stale", {
						expectedGeneration: 99,
						session: { sessionId: dest.sessionId, sessionFile: dest.sessionFile },
						frontierEvidence: [dest.checkpoint],
						checkpointDependencies: [dest.checkpoint],
					}),
				);
				throw new Error("stale activation generation should fail");
			} catch (error) {
				expect(storeError(error).code).toBe("stale-generation");
			}
			await owner.commit({
				expectedGeneration: 1,
				transitionId: "stage-handoff",
				patch: {
					pendingHandoff: stagedHandoff({
						generation: 1,
						sourceSessionFile: seeded.sessionFile,
						destination: dest,
					}),
				},
			});
			const next = await owner.activateOwner(
				activationInput(dest.sessionFile, "act-ok", {
					session: { sessionId: dest.sessionId, sessionFile: dest.sessionFile },
					frontierEvidence: [dest.checkpoint],
					checkpointDependencies: [dest.checkpoint],
					expectedFrontier: owner.getState().frontier,
					expectedPolicyRevision: "pol-1",
				}),
			);
			expect(next.owner.generation).toBe(2);
			expect(next.owner.sessionId).toBe("s2");
			expect(next.frontier.lastCommittedTransitionId).toBe("act-ok");
			expect(next.frontier.evidence).toEqual([dest.checkpoint]);
			expect(next.pendingHandoff).toBeNull();
		});
	});

	it("refuses activation when staged destination bytes, identity, generation, or revision do not match", async () => {
		const seeded = await seedWorktree("activate-faults");
		const dest = await writeStagedSuccessor(seeded.root, "s2");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			await owner.commit({
				expectedGeneration: 1,
				transitionId: "stage-handoff",
				patch: {
					pendingHandoff: stagedHandoff({
						generation: 1,
						sourceSessionFile: seeded.sessionFile,
						destination: dest,
					}),
				},
			});
			const frontier = owner.getState().frontier;
			const base = {
				session: { sessionId: dest.sessionId, sessionFile: dest.sessionFile },
				frontierEvidence: [dest.checkpoint],
				checkpointDependencies: [dest.checkpoint],
				expectedFrontier: frontier,
				expectedPolicyRevision: "pol-1",
			};

			fs.appendFileSync(dest.sessionFile, "tamper");
			try {
				await owner.activateOwner(activationInput(dest.sessionFile, "act-tamper", base));
				throw new Error("tampered destination should not activate");
			} catch (error) {
				expect(storeError(error).code).toBe("destination-mismatch");
			}
			fs.writeFileSync(dest.sessionFile, "staged-session\n");
			expect(owner.getState().owner.generation).toBe(1);

			try {
				await owner.activateOwner(
					activationInput(dest.sessionFile, "act-session", {
						...base,
						session: { sessionId: "other", sessionFile: dest.sessionFile },
					}),
				);
				throw new Error("session mismatch should not activate");
			} catch (error) {
				expect(storeError(error).code).toBe("destination-mismatch");
			}

			try {
				await owner.activateOwner(
					activationInput(dest.sessionFile, "act-revision", {
						...base,
						expectedPolicyRevision: "pol-other",
					}),
				);
				throw new Error("revision mismatch should not activate");
			} catch (error) {
				expect(storeError(error).code).toBe("admission-blocked");
			}

			await owner.commit({
				expectedGeneration: 1,
				transitionId: "restage-stale-source",
				patch: {
					pendingHandoff: stagedHandoff({
						generation: 9,
						sourceSessionFile: seeded.sessionFile,
						destination: dest,
					}),
				},
			});
			try {
				await owner.activateOwner(
					activationInput(dest.sessionFile, "act-source-gen", {
						...base,
						expectedFrontier: owner.getState().frontier,
					}),
				);
				throw new Error("source generation mismatch should not activate");
			} catch (error) {
				expect(storeError(error).code).toBe("stale-generation");
			}
			expect(owner.getState().owner.generation).toBe(1);
			expect(owner.getState().owner.sessionId).toBe("sess-1");
		});
	});

	it("consumes handoff intent on successful staged activation and replaces frontier evidence", async () => {
		const seeded = await seedWorktree("activate-handoff-intent");
		const dest = await writeStagedSuccessor(seeded.root, "s2");
		const prior = await writeImmutableJson(path.join(seeded.root, "prior.json"), { prior: true });
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			await owner.commit({
				expectedGeneration: 1,
				transitionId: "keep-prior",
				immutableDependencies: [prior],
				patch: {
					intent: { kind: "handoff" },
					frontier: { lastCommittedTransitionId: null, lastCommittedEventId: null, evidence: [prior] },
					pendingHandoff: stagedHandoff({
						generation: 1,
						sourceSessionFile: seeded.sessionFile,
						destination: dest,
					}),
				},
			});
			const next = await owner.activateOwner(
				activationInput(dest.sessionFile, "act-handoff-ok", {
					session: { sessionId: dest.sessionId, sessionFile: dest.sessionFile },
					frontierEvidence: [dest.checkpoint],
					checkpointDependencies: [dest.checkpoint],
					expectedFrontier: owner.getState().frontier,
					expectedPolicyRevision: "pol-1",
				}),
			);
			expect(next.intent).toEqual({ kind: "continue" });
			expect(next.pendingHandoff).toBeNull();
			expect(next.owner.generation).toBe(2);
			expect(next.frontier.evidence).toEqual([dest.checkpoint]);
			expect(next.frontier.evidence.some(item => item.sha256 === prior.sha256)).toBe(false);
			expect(next.accounting.sessions.map(item => item.sessionId).sort()).toEqual(["s2", "sess-1"]);
		});
	});

	it("takeOverController fences generation without reconciling pause, effects, or pending transfer", async () => {
		const seeded = await seedWorktree("takeover");
		const dest = await writeStagedSuccessor(seeded.root, "s2");
		const ckpt = dest.checkpoint;
		await withContinuationOwner(
			enrollRequest(seeded.identity, seeded.sessionFile, {
				intent: { kind: "pause", reason: "wait" },
				pendingEffects: [{ id: "fx-unknown", kind: "unknown", unresolved: true }],
				pendingHandoff: stagedHandoff({
					generation: 1,
					sourceSessionFile: seeded.sessionFile,
					destination: dest,
				}),
				stop: { reason: "attention", kind: "attention", at: "now" },
			}),
			async owner => {
				try {
					await owner.takeOverController({
						expectedGeneration: 99,
						expectedFrontier: owner.getState().frontier,
						transitionId: "take-stale",
						frontierEvidence: [ckpt],
						checkpointDependencies: [ckpt],
					});
					throw new Error("stale takeover generation should fail");
				} catch (error) {
					expect(storeError(error).code).toBe("stale-generation");
				}
				const next = await owner.takeOverController({
					expectedGeneration: 1,
					expectedFrontier: owner.getState().frontier,
					transitionId: "take-ok",
					frontierEvidence: [ckpt],
					checkpointDependencies: [ckpt],
				});
				expect(next.owner.generation).toBe(2);
				expect(next.owner.sessionId).toBe("sess-1");
				expect(next.owner.sessionFile).toBe(path.resolve(seeded.sessionFile));
				expect(next.intent).toEqual({ kind: "pause", reason: "wait" });
				expect(next.stop).toEqual({ reason: "attention", kind: "attention", at: "now" });
				expect(next.pendingEffects).toEqual([{ id: "fx-unknown", kind: "unknown", unresolved: true }]);
				expect(next.pendingHandoff?.id).toBe("handoff-1");
				expect(next.pendingHandoff?.phase).toBe("staged");
				expect(next.frontier.evidence.some(item => item.sha256 === ckpt.sha256)).toBe(true);
				try {
					await owner.takeOverController({
						expectedGeneration: 1,
						expectedFrontier: next.frontier,
						transitionId: "take-old-gen",
						frontierEvidence: [ckpt],
						checkpointDependencies: [ckpt],
					});
					throw new Error("old generation must stay fenced");
				} catch (error) {
					expect(storeError(error).code).toBe("stale-generation");
				}
			},
		);
	});
});

describe("owner isolation", () => {
	it("copies state at the boundary so callers cannot mutate authority without persisting", async () => {
		const seeded = await seedWorktree("freeze-state");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			const snapshot = owner.getState();
			snapshot.owner.generation = 99;
			snapshot.pendingEffects.push({ id: "ghost", kind: "x", unresolved: true });
			expect(owner.getState().owner.generation).toBe(1);
			expect(owner.getState().pendingEffects).toEqual([]);
		});
	});

	it("rejects an escaped owner after lock release while a competing owner can recover", async () => {
		const seeded = await seedWorktree("escaped-owner");
		let escaped:
			| {
					commit: (input: {
						expectedGeneration: number;
						transitionId: string;
						patch: { intent: { kind: "continue" } };
					}) => Promise<unknown>;
			  }
			| undefined;
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			escaped = owner;
		});
		if (!escaped) throw new Error("expected escaped owner");
		try {
			await escaped.commit({ expectedGeneration: 1, transitionId: "late", patch: { intent: { kind: "continue" } } });
			throw new Error("escaped owner must not commit after lock release");
		} catch (error) {
			expect(storeError(error).code).toBe("owner-closed");
		}
		await withContinuationOwner({ action: "recover", identity: seeded.identity }, async owner => {
			expect(owner.getState().owner.generation).toBe(1);
			const next = await owner.commit({
				expectedGeneration: 1,
				transitionId: "competitor",
				patch: { intent: { kind: "continue" } },
			});
			expect(next.frontier.lastCommittedTransitionId).toBe("competitor");
		});
	});
});

describe("control-path identity", () => {
	it("refuses a symlink on the control directory before publishing", async () => {
		const seeded = await seedWorktree("control-symlink");
		const key = planKeyFromRelativePath("docs/plans/example.md");
		const sdd = path.join(seeded.root, ".sjujperpowers", "sdd");
		fs.mkdirSync(sdd, { recursive: true });
		fs.writeFileSync(path.join(sdd, ".gitignore"), "*\n");
		const elsewhere = path.join(seeded.root, "elsewhere-omp");
		fs.mkdirSync(elsewhere);
		fs.symlinkSync(elsewhere, path.join(sdd, key));
		try {
			await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async () => {});
			throw new Error("control-path symlink should be rejected");
		} catch (error) {
			expect(storeError(error).code).toBe("symlink-ambiguous");
		}
	});
});

describe("held owner disk authority", () => {
	it("does not overwrite a pause that retains the same generation and frontier", async () => {
		const seeded = await seedWorktree("held-pause");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			const statePath = path.join(owner.getControlDir(), "state.json");
			const changed = owner.getState();
			changed.intent = { kind: "pause", reason: "operator interruption" };
			fs.writeFileSync(statePath, JSON.stringify(changed));
			await expect(
				owner.commit({
					expectedGeneration: changed.owner.generation,
					transitionId: "attempt-after-pause",
					patch: { intent: { kind: "continue" } },
				}),
			).rejects.toMatchObject({ code: "stale-frontier" });
			expect(owner.canAdmitWork()).toBe(false);
			expect(JSON.parse(fs.readFileSync(statePath, "utf8")).intent).toEqual(changed.intent);
		});
	});

	it("does not recreate deleted state.json from stale memory", async () => {
		const seeded = await seedWorktree("held-missing");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			const statePath = path.join(owner.getControlDir(), "state.json");
			fs.unlinkSync(statePath);
			try {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "after-delete",
					patch: { intent: { kind: "continue" } },
				});
				throw new Error("commit must not recreate deleted authority");
			} catch (error) {
				expect(storeError(error).code).toBe("missing-state");
			}
			expect(fs.existsSync(statePath)).toBe(false);
			try {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "after-delete-2",
					patch: { intent: { kind: "continue" } },
				});
				throw new Error("latched owner must not repair deleted authority");
			} catch (error) {
				expect(storeError(error).code).toBe("missing-state");
			}
			expect(fs.existsSync(statePath)).toBe(false);
		});
	});

	it("does not overwrite an externally replaced authority from held memory", async () => {
		const seeded = await seedWorktree("held-replaced");
		await withContinuationOwner(enrollRequest(seeded.identity, seeded.sessionFile), async owner => {
			const statePath = path.join(owner.getControlDir(), "state.json");
			const parsed: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!("owner" in parsed) ||
				!parsed.owner ||
				typeof parsed.owner !== "object"
			) {
				throw new Error("expected enrolled state.json");
			}
			Object.assign(parsed.owner, { generation: 9 });
			if ("run" in parsed && parsed.run && typeof parsed.run === "object") {
				Object.assign(parsed.run, { id: "other-run" });
			}
			fs.writeFileSync(statePath, `${JSON.stringify(parsed)}\n`);
			try {
				await owner.commit({
					expectedGeneration: 1,
					transitionId: "after-replace",
					patch: { intent: { kind: "pause", reason: "stale" } },
				});
				throw new Error("commit must not overwrite replaced authority");
			} catch (error) {
				const code = storeError(error).code;
				expect(code === "identity-mismatch" || code === "stale-generation").toBe(true);
			}
			const after: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
			if (
				!after ||
				typeof after !== "object" ||
				!("owner" in after) ||
				!after.owner ||
				typeof after.owner !== "object"
			) {
				throw new Error("expected surviving replaced state.json");
			}
			expect("generation" in after.owner && after.owner.generation === 9).toBe(true);
			expect(
				"run" in after &&
					after.run &&
					typeof after.run === "object" &&
					"id" in after.run &&
					after.run.id === "other-run",
			).toBe(true);
			try {
				await owner.activateOwner(activationInput(seeded.sessionFile, "activate-after-replace"));
				throw new Error("activate must not overwrite replaced authority");
			} catch (error) {
				const code = storeError(error).code;
				expect(code === "identity-mismatch" || code === "stale-generation").toBe(true);
			}
			const still: unknown = JSON.parse(fs.readFileSync(statePath, "utf8"));
			if (
				!still ||
				typeof still !== "object" ||
				!("owner" in still) ||
				!still.owner ||
				typeof still.owner !== "object"
			) {
				throw new Error("expected replaced state.json after activate");
			}
			expect("generation" in still.owner && still.owner.generation === 9).toBe(true);
		});
	});
});
