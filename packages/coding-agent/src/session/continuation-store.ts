/**
 * Canonical OMP run-control store: one `state.json` authority per worktree/plan,
 * a lifetime native owner lock, and synchronized publication of immutable
 * evidence references. This is not session `flush()` and not a PID lease.
 */
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { type FileLockOptions, hasFsCode, isEnoent, withFileLock } from "@oh-my-pi/pi-utils";

export const CONTINUATION_STATE_VERSION = 1 as const;
export const SDD_GITIGNORE_RELATIVE = ".sjujperpowers/sdd/.gitignore";
export const SDD_GITIGNORE_CONTENTS = "*\n";
export const CONTROL_STATE_FILENAME = "state.json";
export const CONTROL_STATE_TEMP_PREFIX = ".state.json.";
export const OWNER_LOCK_BASENAME = "owner";
export const ARCHIVED_RUNS_DIRNAME = "archived-runs";

/** Shared local evidence wire shape. `sha256` covers exactly the first `byteLength` bytes at `path`. */
export interface FileEvidenceRef {
	kind: "file";
	path: string;
	byteLength: number;
	sha256: string;
}

export interface ContinuationEvidenceCursor {
	generation: number;
	byteLength: number;
}

export interface RetainContinuationEvidenceRequest {
	destinationPath: string;
	/** Omit to retain the complete prefix selected inside the writer serialization barrier. */
	byteLength?: number;
	previous?: {
		generation: number;
		byteLength: number;
		path: string;
		sha256: string;
	};
	io?: ContinuationEvidenceIo;
}

export interface ContinuationEvidenceRetention {
	evidence: FileEvidenceRef;
	cursor: ContinuationEvidenceCursor;
	metrics: { bytesCopied: number; bytesHashed: number };
}

export interface ContinuationEvidenceIo {
	writeFile(filePath: string, data: Uint8Array): void;
	appendFile(filePath: string, data: Uint8Array): void;
	fsyncFile(filePath: string): void;
	fsyncDir(dirPath: string): void;
	mkdirp(dirPath: string): void;
	exists(filePath: string): boolean;
	realpath(filePath: string): string;
	readRange(filePath: string, offset: number, byteLength: number): Uint8Array;
}

export function createNodeEvidenceIo(): ContinuationEvidenceIo {
	return {
		writeFile(filePath, data) {
			fs.writeFileSync(filePath, data, { mode: 0o600, flag: "wx" });
		},
		appendFile(filePath, data) {
			fs.appendFileSync(filePath, data);
		},
		fsyncFile(filePath) {
			const fd = fs.openSync(filePath, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		},
		fsyncDir(dirPath) {
			const fd = fs.openSync(dirPath, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
		},
		mkdirp(dirPath) {
			fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
		},
		exists(filePath) {
			return fs.existsSync(filePath);
		},
		realpath(filePath) {
			return fs.realpathSync(filePath);
		},
		readRange(filePath, offset, byteLength) {
			const fd = fs.openSync(filePath, "r");
			try {
				const buf = Buffer.alloc(byteLength);
				let read = 0;
				while (read < byteLength) {
					const n = fs.readSync(fd, buf, read, byteLength - read, offset + read);
					if (n === 0) break;
					read += n;
				}
				if (read !== byteLength) {
					throw new Error(
						`Short read from ${filePath}: expected ${byteLength} bytes at offset ${offset}, got ${read}`,
					);
				}
				return buf;
			} finally {
				fs.closeSync(fd);
			}
		},
	};
}

export interface CanonicalPlanIdentity {
	root: string;
	relativePath: string;
	pathSha256: string;
}

export interface CanonicalPlanIdentityInput {
	worktree: string;
	planPath: string;
}

export type ContinuationLockScope =
	| {
			kind: "linux-abstract-socket";
			lockTarget: string;
			networkNamespace: string;
			crossNamespaceCertified: false;
			limitation: string;
	  }
	| {
			kind: "flock";
			lockPath: string;
			crossNamespaceCertified: false;
	  }
	| {
			kind: "windows-named-mutex";
			lockTarget: string;
			crossNamespaceCertified: false;
	  };

export interface RunOwnerRecord {
	sessionId: string;
	sessionFile: string;
	generation: number;
}

export type OperatorIntent =
	| { kind: "continue" }
	| { kind: "pause"; reason?: string }
	| { kind: "stop"; reason: string }
	| { kind: "handoff" };

export interface DurableFrontier {
	lastCommittedTransitionId: string | null;
	lastCommittedEventId: string | null;
	evidence: FileEvidenceRef[];
}

export interface PendingEffect {
	id: string;
	kind: string;
	unresolved: true;
	identity?: string;
	launchedAt?: string;
}

export type PendingHandoffPhase = "preparing" | "staged";

export interface PendingHandoffSource {
	sessionId: string;
	sessionFile?: string;
	generation: number;
}

export interface PreparingHandoffDestination {
	provider?: string;
	account?: string;
	model?: string;
}

export interface StagedHandoffDestination {
	provider?: string;
	account?: string;
	model?: string;
	sessionId: string;
	sessionFile: string;
	transcript: FileEvidenceRef;
	checkpoint: FileEvidenceRef;
}

export type PendingHandoff =
	| {
			id: string;
			phase: "preparing";
			source: PendingHandoffSource;
			destination: PreparingHandoffDestination;
			policyRevision: string;
	  }
	| {
			id: string;
			phase: "staged";
			source: PendingHandoffSource;
			destination: StagedHandoffDestination;
			policyRevision: string;
	  };

export interface RejectedAttempt {
	id: string;
	reason: string;
	at: string;
}

export interface StopRecord {
	reason: string;
	kind: "attention" | "operator" | "exhausted";
	at: string;
}

export interface WorkerAccounting {
	identity: string;
	status: "live" | "settled";
	launchedAt?: string;
	sessionId?: string;
}

export interface RunAccounting {
	workers: WorkerAccounting[];
	sessions: Array<{ sessionId: string; sessionFile: string }>;
}

export interface CommittedRecord {
	id: string;
	fingerprint: string;
}

export interface RunStateV1 {
	version: 1;
	plan: CanonicalPlanIdentity;
	run: { id: string; terminal: boolean };
	owner: RunOwnerRecord;
	intent: OperatorIntent;
	frontier: DurableFrontier;
	pendingEffects: PendingEffect[];
	pendingHandoff: PendingHandoff | null;
	rejectedAttempts: RejectedAttempt[];
	stop: StopRecord | null;
	accounting: RunAccounting;
	committedTransitions: CommittedRecord[];
	committedEvents: CommittedRecord[];
	lockScope: ContinuationLockScope;
}

export type ContinuationStoreErrorCode =
	| "symlink-ambiguous"
	| "identity-mismatch"
	| "relocation-ambiguous"
	| "gitignore-unverified"
	| "missing-state"
	| "corrupt-state"
	| "torn-state"
	| "existing-authority"
	| "stale-generation"
	| "stale-frontier"
	| "duplicate-transition"
	| "contradictory-duplicate"
	| "duplicate-event"
	| "publication-failed"
	| "unresolved-effects"
	| "run-terminal"
	| "admission-blocked"
	| "owner-closed"
	| "unsupported-lock-scope"
	| "unsupported-storage"
	| "overwrite-retained-evidence"
	| "missing-session-file"
	| "prefix-out-of-range"
	| "handoff-not-staged"
	| "destination-mismatch";

export class ContinuationStoreError extends Error {
	readonly code: ContinuationStoreErrorCode;
	readonly details: Record<string, unknown> | undefined;

	constructor(code: ContinuationStoreErrorCode, message: string, details?: Record<string, unknown>) {
		super(message);
		this.name = "ContinuationStoreError";
		this.code = code;
		this.details = details;
	}
}

export interface ContinuationDurableIo {
	mkdir(dir: string, options?: { recursive?: boolean; mode?: number }): Promise<void>;
	writeFile(filePath: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
	writeFileExclusive(filePath: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
	readFile(filePath: string): Promise<Buffer>;
	rename(from: string, to: string): Promise<void>;
	link(existingPath: string, newPath: string): Promise<void>;
	unlink(filePath: string): Promise<void>;
	fsyncFile(filePath: string): Promise<void>;
	fsyncDir(dirPath: string): Promise<void>;
	lstat(filePath: string): Promise<fs.Stats>;
	realpath(filePath: string): Promise<string>;
	chmod(filePath: string, mode: number): Promise<void>;
	exists(filePath: string): Promise<boolean>;
	readlink?(filePath: string): Promise<string>;
}

export interface RunEnrollment {
	runId: string;
	owner: { sessionId: string; sessionFile: string };
	intent?: OperatorIntent;
	pendingEffects?: PendingEffect[];
	pendingHandoff?: PendingHandoff | null;
	accounting?: RunAccounting;
	stop?: StopRecord | null;
}

export type ContinuationOwnerRequest =
	| { action: "enroll"; identity: CanonicalPlanIdentityInput; initial: RunEnrollment }
	| { action: "recover"; identity: CanonicalPlanIdentityInput; expectedRunId?: string };

export interface ContinuationCommit {
	expectedGeneration: number;
	transitionId: string;
	eventId?: string;
	patch: RunStatePatch;
	immutableDependencies?: FileEvidenceRef[];
}

export interface RunStatePatch {
	intent?: OperatorIntent;
	frontier?: DurableFrontier;
	pendingEffects?: PendingEffect[];
	pendingHandoff?: PendingHandoff | null;
	rejectedAttempts?: RejectedAttempt[];
	stop?: StopRecord | null;
	accounting?: RunAccounting;
	runTerminal?: boolean;
}

/**
 * Serialized owner takeover for Task 5. This is the only way to advance
 * `owner.generation`; {@link ContinuationCommit} cannot patch owner identity.
 */
export interface ContinuationActivation {
	expectedGeneration: number;
	transitionId: string;
	eventId?: string;
	handoffId: string;
	session: { sessionId: string; sessionFile: string };
	frontierEvidence: FileEvidenceRef[];
	checkpointDependencies: FileEvidenceRef[];
	expectedFrontier?: {
		lastCommittedTransitionId: string | null;
		lastCommittedEventId: string | null;
		evidence?: FileEvidenceRef[];
	};
	expectedPolicyRevision?: string;
}

/**
 * Explicit same-session controller recovery. Fences the prior generation
 * without adopting a successor session or reconciling barriers.
 */
export interface ContinuationControllerTakeover {
	expectedGeneration: number;
	expectedFrontier: {
		lastCommittedTransitionId: string | null;
		lastCommittedEventId: string | null;
		evidence?: FileEvidenceRef[];
	};
	transitionId: string;
	eventId?: string;
	frontierEvidence: FileEvidenceRef[];
	checkpointDependencies: FileEvidenceRef[];
}

export interface ContinuationOwner {
	getState(): RunStateV1;
	getLockScope(): ContinuationLockScope;
	getControlDir(): string;
	getIdentity(): CanonicalPlanIdentity;
	/**
	 * Conservative recovery readiness, not live in-flight accounting.
	 *
	 * True only when a recovered controller may admit ordinary work: the run is
	 * nonterminal, intent is `continue`, there is no stop record, no pending
	 * handoff, no unresolved effects, and no live workers. Pause/stop intents,
	 * operator/exhausted/attention stops, and staged handoff block admission.
	 * Successor activation is a separate staged-handoff transition and does not
	 * use this predicate as a replacement permit. Main owns active-operation
	 * accounting for an already-admitted owner; this predicate does not observe
	 * that concurrency.
	 */
	canAdmitWork(): boolean;
	commit(input: ContinuationCommit): Promise<RunStateV1>;
	activateOwner(input: ContinuationActivation): Promise<RunStateV1>;
	takeOverController(input: ContinuationControllerTakeover): Promise<RunStateV1>;
}

export interface InspectCommittedResult {
	identity: CanonicalPlanIdentity;
	controlDir: string;
	state: RunStateV1;
}

export interface ContinuationOwnerOptions {
	lock?: FileLockOptions;
	io?: ContinuationDurableIo;
}

const LINUX_ABSTRACT_LIMITATION =
	"Linux abstract sockets are network-namespace-scoped. Same-namespace tests do not certify cross-namespace exclusion.";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Bytes(data: Uint8Array | string): string {
	return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

export function planKeyFromRelativePath(relativePath: string): string {
	return sha256Bytes(relativePath);
}

export function controlDirectory(identity: CanonicalPlanIdentity): string {
	return path.join(identity.root, ".sjujperpowers", "sdd", identity.pathSha256, "omp");
}

export function ownerLockTarget(controlDir: string): string {
	return path.join(controlDir, OWNER_LOCK_BASENAME);
}

export function createNodeDurableIo(): ContinuationDurableIo {
	return {
		async mkdir(dir, options) {
			await fsp.mkdir(dir, { recursive: options?.recursive ?? true, mode: options?.mode });
			if (options?.mode !== undefined) await fsp.chmod(dir, options.mode);
		},
		writeFile(filePath, data, options) {
			return fsp.writeFile(filePath, data, options?.mode !== undefined ? { mode: options.mode } : undefined);
		},
		async writeFileExclusive(filePath, data, options) {
			const handle = await fsp.open(filePath, "wx", options?.mode ?? 0o600);
			try {
				await handle.writeFile(data);
			} finally {
				await handle.close();
			}
		},
		readFile(filePath) {
			return fsp.readFile(filePath);
		},
		rename(from, to) {
			return fsp.rename(from, to);
		},
		link(existingPath, newPath) {
			return fsp.link(existingPath, newPath);
		},
		unlink(filePath) {
			return fsp.unlink(filePath);
		},
		async fsyncFile(filePath) {
			const fh = await fsp.open(filePath, "r");
			try {
				await fh.sync();
			} finally {
				await fh.close();
			}
		},
		async fsyncDir(dirPath) {
			const fh = await fsp.open(dirPath, "r");
			try {
				await fh.sync();
			} finally {
				await fh.close();
			}
		},
		lstat(filePath) {
			return fsp.lstat(filePath);
		},
		realpath(filePath) {
			return fsp.realpath(filePath);
		},
		chmod(filePath, mode) {
			return fsp.chmod(filePath, mode);
		},
		async exists(filePath) {
			try {
				await fsp.access(filePath);
				return true;
			} catch {
				return false;
			}
		},
		readlink(filePath) {
			return fsp.readlink(filePath);
		},
	};
}

export async function resolveCanonicalPlanIdentity(
	input: CanonicalPlanIdentityInput,
	io: ContinuationDurableIo = createNodeDurableIo(),
): Promise<CanonicalPlanIdentity> {
	const worktreeAbs = path.resolve(input.worktree);
	const worktreeReal = await io.realpath(worktreeAbs);
	const worktreeStat = await io.lstat(worktreeReal);
	if (!worktreeStat.isDirectory()) {
		throw new ContinuationStoreError("identity-mismatch", `Worktree is not a directory: ${worktreeReal}`);
	}
	const root = await resolveOwnershipRoot(worktreeReal, io);
	const planAbs = path.isAbsolute(input.planPath)
		? path.resolve(input.planPath)
		: path.resolve(worktreeReal, input.planPath);
	await assertNoSymlinkAlong(root, planAbs, io);
	let planReal: string;
	try {
		planReal = await io.realpath(planAbs);
	} catch (error) {
		throw new ContinuationStoreError("identity-mismatch", `Plan path is not reachable: ${planAbs}`, {
			error: String(error),
		});
	}
	const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
	if (planReal !== root && !planReal.startsWith(rootPrefix)) {
		throw new ContinuationStoreError(
			"relocation-ambiguous",
			`Plan ${planReal} is outside canonical worktree ${root}`,
			{
				root,
				planReal,
			},
		);
	}
	const relativePath = path.relative(root, planReal).split(path.sep).join("/");
	if (relativePath.length === 0 || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new ContinuationStoreError("identity-mismatch", `Plan is not repository-relative under ${root}`, {
			root,
			planReal,
			relativePath,
		});
	}
	return { root, relativePath, pathSha256: planKeyFromRelativePath(relativePath) };
}

async function resolveOwnershipRoot(worktree: string, io: ContinuationDurableIo): Promise<string> {
	let discovered: string | undefined;
	try {
		discovered = vcs.repo(worktree)?.root() ?? vcs.gitInfo(worktree)?.repoRoot ?? vcs.jj(worktree)?.root();
	} catch {
		discovered = undefined;
	}
	if (!discovered) return worktree;
	try {
		return await io.realpath(discovered);
	} catch (error) {
		throw new ContinuationStoreError("identity-mismatch", `Repository root is not reachable: ${discovered}`, {
			error: String(error),
		});
	}
}

export async function inspectCommittedRunState(
	input: CanonicalPlanIdentityInput,
	io: ContinuationDurableIo = createNodeDurableIo(),
): Promise<InspectCommittedResult> {
	const identity = await resolveCanonicalPlanIdentity(input, io);
	const controlDir = controlDirectory(identity);
	await assertControlPathsUnambiguous(identity.root, controlDir, io);
	const state = await readCommittedState(controlDir, identity, io);
	return { identity, controlDir, state };
}

export async function withContinuationOwner<T>(
	request: ContinuationOwnerRequest,
	fn: (owner: ContinuationOwner) => Promise<T>,
	options: ContinuationOwnerOptions = {},
): Promise<T> {
	const io = options.io ?? createNodeDurableIo();
	const identity = await resolveCanonicalPlanIdentity(request.identity, io);
	await ensureSddGitignore(identity.root, io);
	const controlDir = controlDirectory(identity);
	await assertNoSymlinkAlong(identity.root, controlDir, io);
	await io.mkdir(controlDir, { recursive: true, mode: 0o700 });
	await assertControlPathsUnambiguous(identity.root, controlDir, io);
	await fsyncAncestors(controlDir, identity.root, io);
	const lockTarget = ownerLockTarget(controlDir);
	const lockScope = await resolveLockScope(lockTarget, io);
	return await withFileLock(
		lockTarget,
		async () => {
			const owner = await openOwner(request, identity, controlDir, lockScope, io);
			try {
				return await fn(owner);
			} finally {
				await owner.closeOwnership();
			}
		},
		options.lock,
	);
}

/**
 * Conservative recovery readiness, not live in-flight accounting.
 * See {@link ContinuationOwner.canAdmitWork}.
 */
export function isRecoveredOwnerAdmissible(state: RunStateV1): boolean {
	if (state.run.terminal) return false;
	if (state.intent.kind !== "continue") return false;
	if (state.stop !== null) return false;
	if (state.pendingHandoff !== null) return false;
	if (state.pendingEffects.length > 0) return false;
	if (state.accounting.workers.some(worker => worker.status === "live")) return false;
	return true;
}

function stableStringify(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const obj = value as Record<string, unknown>;
	return `{${Object.keys(obj)
		.filter(key => obj[key] !== undefined)
		.sort()
		.map(key => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
		.join(",")}}`;
}

function fingerprintOf(value: unknown): string {
	return sha256Bytes(stableStringify(value));
}

function cloneState<T>(state: T): T {
	return structuredClone(state);
}

async function assertNoSymlinkAlong(root: string, target: string, io: ContinuationDurableIo): Promise<void> {
	const relative = path.relative(root, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new ContinuationStoreError("relocation-ambiguous", `Path ${target} is not inside ${root}`);
	}
	let current = root;
	for (const part of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, part);
		let stat: fs.Stats;
		try {
			stat = await io.lstat(current);
		} catch (error) {
			if (isEnoent(error)) return;
			throw error;
		}
		if (stat.isSymbolicLink()) {
			throw new ContinuationStoreError(
				"symlink-ambiguous",
				`Unexpected symlink in control or plan path at ${current}`,
				{
					root,
					target,
					symlink: current,
				},
			);
		}
	}
}

async function assertControlPathsUnambiguous(
	root: string,
	controlDir: string,
	io: ContinuationDurableIo,
): Promise<void> {
	await assertNoSymlinkAlong(root, controlDir, io);
	await assertNoSymlinkAlong(root, path.join(controlDir, CONTROL_STATE_FILENAME), io);
	await assertNoSymlinkAlong(root, ownerLockTarget(controlDir), io);
	await assertNoSymlinkAlong(root, `${ownerLockTarget(controlDir)}.lock`, io);
}

async function fsyncAncestors(fromDir: string, stopAt: string, io: ContinuationDurableIo): Promise<void> {
	const stop = path.resolve(stopAt);
	let current = path.resolve(fromDir);
	for (;;) {
		await io.fsyncDir(current);
		if (current === stop) return;
		const parent = path.dirname(current);
		if (parent === current) return;
		current = parent;
	}
}

async function ensureSddGitignore(root: string, io: ContinuationDurableIo): Promise<void> {
	const sddDir = path.join(root, ".sjujperpowers", "sdd");
	await assertNoSymlinkAlong(root, sddDir, io);
	await io.mkdir(sddDir, { recursive: true, mode: 0o700 });
	await assertNoSymlinkAlong(root, sddDir, io);
	const gitignorePath = path.join(root, SDD_GITIGNORE_RELATIVE);
	await assertNoSymlinkAlong(root, gitignorePath, io);
	if (!(await io.exists(gitignorePath))) {
		try {
			await io.writeFileExclusive(gitignorePath, SDD_GITIGNORE_CONTENTS, { mode: 0o644 });
		} catch (error) {
			if (!hasFsCode(error, "EEXIST")) throw error;
		}
	}
	const contents = (await io.readFile(gitignorePath)).toString("utf8");
	if (contents.trim() !== "*") {
		throw new ContinuationStoreError(
			"gitignore-unverified",
			`Refusing to publish control state: ${SDD_GITIGNORE_RELATIVE} must contain only '*'`,
			{ gitignorePath, contents },
		);
	}
	await io.fsyncFile(gitignorePath);
	await fsyncAncestors(sddDir, root, io);
}

async function resolveLockScope(lockTarget: string, io: ContinuationDurableIo): Promise<ContinuationLockScope> {
	if (process.platform === "linux") {
		if (!io.readlink) {
			throw new ContinuationStoreError(
				"unsupported-lock-scope",
				"Cannot determine Linux network namespace for abstract-socket lock identity; refusing exclusive ownership rather than silently authorizing a competing owner.",
			);
		}
		let networkNamespace: string;
		try {
			networkNamespace = await io.readlink("/proc/self/ns/net");
		} catch (error) {
			throw new ContinuationStoreError(
				"unsupported-lock-scope",
				"Cannot determine Linux network namespace for abstract-socket lock identity; refusing exclusive ownership rather than silently authorizing a competing owner.",
				{ error: String(error) },
			);
		}
		if (!networkNamespace.startsWith("net:")) {
			throw new ContinuationStoreError(
				"unsupported-lock-scope",
				`Unrecognized network namespace identity '${networkNamespace}'; refusing exclusive ownership.`,
				{ networkNamespace },
			);
		}
		return {
			kind: "linux-abstract-socket",
			lockTarget,
			networkNamespace,
			crossNamespaceCertified: false,
			limitation: LINUX_ABSTRACT_LIMITATION,
		};
	}
	if (process.platform === "win32") {
		return { kind: "windows-named-mutex", lockTarget, crossNamespaceCertified: false };
	}
	return { kind: "flock", lockPath: `${path.resolve(lockTarget)}.lock`, crossNamespaceCertified: false };
}

function assertLockScopeCompatible(recorded: ContinuationLockScope, current: ContinuationLockScope): void {
	if (recorded.kind !== current.kind) {
		throw new ContinuationStoreError(
			"unsupported-lock-scope",
			`Recorded lock scope ${recorded.kind} does not match current ${current.kind}`,
			{ recorded, current },
		);
	}
	if (recorded.kind === "linux-abstract-socket" && current.kind === "linux-abstract-socket") {
		if (recorded.networkNamespace !== current.networkNamespace) {
			throw new ContinuationStoreError(
				"unsupported-lock-scope",
				"Linux abstract-socket lock namespace does not match the recorded owner; refusing competing authorization. Cross-namespace exclusion is not certified.",
				{ recorded: recorded.networkNamespace, current: current.networkNamespace },
			);
		}
	}
}

async function readCommittedState(
	controlDir: string,
	identity: CanonicalPlanIdentity,
	io: ContinuationDurableIo,
): Promise<RunStateV1> {
	const statePath = path.join(controlDir, CONTROL_STATE_FILENAME);
	if (!(await io.exists(statePath))) {
		throw new ContinuationStoreError(
			"missing-state",
			"Missing continuation state.json; recovery will not create a replacement run.",
			{ statePath },
		);
	}
	const stat = await io.lstat(statePath);
	if (stat.isSymbolicLink()) {
		throw new ContinuationStoreError("symlink-ambiguous", `state.json is a symlink at ${statePath}`);
	}
	let raw: Buffer;
	try {
		raw = await io.readFile(statePath);
	} catch (error) {
		throw new ContinuationStoreError("corrupt-state", `Failed to read committed state.json: ${String(error)}`, {
			statePath,
		});
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw.toString("utf8"));
	} catch (error) {
		throw new ContinuationStoreError("corrupt-state", `Committed state.json is not valid JSON: ${String(error)}`, {
			statePath,
		});
	}
	const state = parseRunState(parsed, statePath);
	assertIdentityMatch(state.plan, identity);
	return state;
}

function requireObject(value: unknown, label: string, statePath: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new ContinuationStoreError("corrupt-state", `RunStateV1 ${label} must be an object`, { statePath, label });
	}
	return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, statePath: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new ContinuationStoreError("corrupt-state", `RunStateV1 ${key} must be a nonempty string`, {
			statePath,
			key,
		});
	}
	return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, statePath: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new ContinuationStoreError("corrupt-state", `RunStateV1 ${key} must be a boolean`, { statePath, key });
	}
	return value;
}

function requireArray(record: Record<string, unknown>, key: string, statePath: string): unknown[] {
	const value = record[key];
	if (!Array.isArray(value)) {
		throw new ContinuationStoreError("corrupt-state", `RunStateV1 ${key} must be present as an array`, {
			statePath,
			key,
		});
	}
	return value;
}

function requireNullableString(value: unknown, label: string, statePath: string): string | null {
	if (value === null) return null;
	if (typeof value !== "string" || value.length === 0) {
		throw new ContinuationStoreError("corrupt-state", `${label} must be a nonempty string or null`, {
			statePath,
			label,
		});
	}
	return value;
}

function parseRunState(value: unknown, statePath: string): RunStateV1 {
	const record = requireObject(value, "root", statePath);
	if (record.version !== 1) {
		throw new ContinuationStoreError("corrupt-state", `Unsupported RunState version ${String(record.version)}`, {
			statePath,
		});
	}
	const planObj = requireObject(record.plan, "plan", statePath);
	const relativePath = requireString(planObj, "relativePath", statePath);
	const pathSha256 = requireString(planObj, "pathSha256", statePath);
	if (pathSha256 !== planKeyFromRelativePath(relativePath) || !SHA256_HEX.test(pathSha256)) {
		throw new ContinuationStoreError("corrupt-state", "plan.pathSha256 does not match the relative path", {
			statePath,
		});
	}
	const plan: CanonicalPlanIdentity = {
		root: requireString(planObj, "root", statePath),
		relativePath,
		pathSha256,
	};
	const runObj = requireObject(record.run, "run", statePath);
	const ownerObj = requireObject(record.owner, "owner", statePath);
	const generation = ownerObj.generation;
	if (typeof generation !== "number" || !Number.isInteger(generation) || generation < 1) {
		throw new ContinuationStoreError("corrupt-state", "owner.generation must be an integer >= 1", { statePath });
	}
	return {
		version: 1,
		plan,
		run: { id: requireString(runObj, "id", statePath), terminal: requireBoolean(runObj, "terminal", statePath) },
		owner: {
			sessionId: requireString(ownerObj, "sessionId", statePath),
			sessionFile: requireString(ownerObj, "sessionFile", statePath),
			generation,
		},
		intent: parseIntent(record.intent, statePath),
		frontier: parseFrontier(record.frontier, statePath),
		pendingEffects: requireArray(record, "pendingEffects", statePath).map((item, index) =>
			parsePendingEffect(item, statePath, index),
		),
		pendingHandoff: parsePendingHandoff(record.pendingHandoff, statePath),
		rejectedAttempts: requireArray(record, "rejectedAttempts", statePath).map((item, index) =>
			parseRejectedAttempt(item, statePath, index),
		),
		stop: parseStop(record.stop, statePath),
		accounting: parseAccounting(record.accounting, statePath),
		committedTransitions: requireArray(record, "committedTransitions", statePath).map((item, index) =>
			parseCommitted(item, statePath, "committedTransitions", index),
		),
		committedEvents: requireArray(record, "committedEvents", statePath).map((item, index) =>
			parseCommitted(item, statePath, "committedEvents", index),
		),
		lockScope: parseLockScope(record.lockScope, statePath),
	};
}

function parseIntent(value: unknown, statePath: string): OperatorIntent {
	const record = requireObject(value, "intent", statePath);
	const kind = record.kind;
	if (kind === "continue") return { kind: "continue" };
	if (kind === "pause") {
		if (record.reason !== undefined && typeof record.reason !== "string") {
			throw new ContinuationStoreError("corrupt-state", "intent.pause reason must be a string", { statePath });
		}
		return record.reason === undefined ? { kind: "pause" } : { kind: "pause", reason: record.reason };
	}
	if (kind === "stop") {
		if (typeof record.reason !== "string" || record.reason.length === 0) {
			throw new ContinuationStoreError("corrupt-state", "intent.stop requires a reason", { statePath });
		}
		return { kind: "stop", reason: record.reason };
	}
	if (kind === "handoff") return { kind: "handoff" };
	throw new ContinuationStoreError("corrupt-state", `Invalid operator intent ${String(kind)}`, { statePath });
}

function parseFrontier(value: unknown, statePath: string): DurableFrontier {
	const record = requireObject(value, "frontier", statePath);
	return {
		lastCommittedTransitionId: requireNullableString(
			record.lastCommittedTransitionId,
			"frontier.lastCommittedTransitionId",
			statePath,
		),
		lastCommittedEventId: requireNullableString(
			record.lastCommittedEventId,
			"frontier.lastCommittedEventId",
			statePath,
		),
		evidence: requireArray(record, "evidence", statePath).map((item, index) =>
			parseEvidenceRef(item, `frontier.evidence[${index}]`, statePath),
		),
	};
}

function parseEvidenceRef(value: unknown, label: string, statePath: string): FileEvidenceRef {
	const record = requireObject(value, label, statePath);
	if (record.kind !== "file") {
		throw new ContinuationStoreError("corrupt-state", `${label}.kind must be "file"`, { statePath });
	}
	const byteLength = record.byteLength;
	if (typeof byteLength !== "number" || !Number.isInteger(byteLength) || byteLength < 0) {
		throw new ContinuationStoreError("corrupt-state", `${label}.byteLength must be an integer >= 0`, {
			statePath,
		});
	}
	const sha256 = requireString(record, "sha256", statePath);
	if (!SHA256_HEX.test(sha256)) {
		throw new ContinuationStoreError("corrupt-state", `${label}.sha256 must be a sha256 hex digest`, {
			statePath,
		});
	}
	return { kind: "file", path: requireString(record, "path", statePath), byteLength, sha256 };
}

function parsePendingEffect(value: unknown, statePath: string, index: number): PendingEffect {
	const record = requireObject(value, `pendingEffects[${index}]`, statePath);
	if (record.unresolved !== true) {
		throw new ContinuationStoreError("corrupt-state", `pendingEffects[${index}].unresolved must be true`, {
			statePath,
		});
	}
	const effect: PendingEffect = {
		id: requireString(record, "id", statePath),
		kind: requireString(record, "kind", statePath),
		unresolved: true,
	};
	if (record.identity !== undefined) {
		if (typeof record.identity !== "string" || record.identity.length === 0) {
			throw new ContinuationStoreError(
				"corrupt-state",
				`pendingEffects[${index}].identity must be a nonempty string`,
				{
					statePath,
				},
			);
		}
		effect.identity = record.identity;
	}
	if (record.launchedAt !== undefined) {
		if (typeof record.launchedAt !== "string") {
			throw new ContinuationStoreError("corrupt-state", `pendingEffects[${index}].launchedAt must be a string`, {
				statePath,
			});
		}
		effect.launchedAt = record.launchedAt;
	}
	return effect;
}

function requirePositiveInteger(value: unknown, label: string, statePath: string): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new ContinuationStoreError("corrupt-state", `${label} must be an integer >= 1`, { statePath, label });
	}
	return value;
}

function parsePendingHandoff(value: unknown, statePath: string): PendingHandoff | null {
	if (value === null) return null;
	const record = requireObject(value, "pendingHandoff", statePath);
	const source = requireObject(record.source, "pendingHandoff.source", statePath);
	const destination = requireObject(record.destination, "pendingHandoff.destination", statePath);
	const phase = record.phase;
	if (phase !== "preparing" && phase !== "staged") {
		throw new ContinuationStoreError("corrupt-state", 'pendingHandoff.phase must be "preparing" or "staged"', {
			statePath,
		});
	}
	const parsedSource: PendingHandoffSource = {
		sessionId: requireString(source, "sessionId", statePath),
		sessionFile: optionalString(source.sessionFile),
		generation: requirePositiveInteger(source.generation, "pendingHandoff.source.generation", statePath),
	};
	const destinationBase: PreparingHandoffDestination = {
		provider: optionalString(destination.provider),
		account: optionalString(destination.account),
		model: optionalString(destination.model),
	};
	if (phase === "preparing") {
		return {
			id: requireString(record, "id", statePath),
			phase: "preparing",
			source: parsedSource,
			destination: destinationBase,
			policyRevision: requireString(record, "policyRevision", statePath),
		};
	}
	return {
		id: requireString(record, "id", statePath),
		phase: "staged",
		source: parsedSource,
		destination: {
			...destinationBase,
			sessionId: requireString(destination, "sessionId", statePath),
			sessionFile: requireString(destination, "sessionFile", statePath),
			transcript: parseEvidenceRef(destination.transcript, "pendingHandoff.destination.transcript", statePath),
			checkpoint: parseEvidenceRef(destination.checkpoint, "pendingHandoff.destination.checkpoint", statePath),
		},
		policyRevision: requireString(record, "policyRevision", statePath),
	};
}

function optionalString(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") {
		throw new ContinuationStoreError("corrupt-state", "Optional string field has a non-string value");
	}
	return value;
}

function parseRejectedAttempt(value: unknown, statePath: string, index: number): RejectedAttempt {
	const record = requireObject(value, `rejectedAttempts[${index}]`, statePath);
	return {
		id: requireString(record, "id", statePath),
		reason: requireString(record, "reason", statePath),
		at: requireString(record, "at", statePath),
	};
}

function parseStop(value: unknown, statePath: string): StopRecord | null {
	if (value === null) return null;
	const record = requireObject(value, "stop", statePath);
	const kind = record.kind;
	if (kind !== "attention" && kind !== "operator" && kind !== "exhausted") {
		throw new ContinuationStoreError("corrupt-state", `Invalid stop.kind ${String(kind)}`, { statePath });
	}
	return { reason: requireString(record, "reason", statePath), kind, at: requireString(record, "at", statePath) };
}

function parseAccounting(value: unknown, statePath: string): RunAccounting {
	const record = requireObject(value, "accounting", statePath);
	return {
		workers: requireArray(record, "workers", statePath).map((item, index) => {
			const worker = requireObject(item, `accounting.workers[${index}]`, statePath);
			const status = worker.status;
			if (status !== "live" && status !== "settled") {
				throw new ContinuationStoreError("corrupt-state", `Invalid worker status ${String(status)}`, { statePath });
			}
			const parsed: WorkerAccounting = {
				identity: requireString(worker, "identity", statePath),
				status,
			};
			if (worker.launchedAt !== undefined) {
				if (typeof worker.launchedAt !== "string") {
					throw new ContinuationStoreError("corrupt-state", "worker.launchedAt must be a string", { statePath });
				}
				parsed.launchedAt = worker.launchedAt;
			}
			if (worker.sessionId !== undefined) {
				if (typeof worker.sessionId !== "string") {
					throw new ContinuationStoreError("corrupt-state", "worker.sessionId must be a string", { statePath });
				}
				parsed.sessionId = worker.sessionId;
			}
			return parsed;
		}),
		sessions: requireArray(record, "sessions", statePath).map((item, index) => {
			const session = requireObject(item, `accounting.sessions[${index}]`, statePath);
			return {
				sessionId: requireString(session, "sessionId", statePath),
				sessionFile: requireString(session, "sessionFile", statePath),
			};
		}),
	};
}

function parseCommitted(value: unknown, statePath: string, label: string, index: number): CommittedRecord {
	const record = requireObject(value, `${label}[${index}]`, statePath);
	const fingerprint = requireString(record, "fingerprint", statePath);
	if (!SHA256_HEX.test(fingerprint)) {
		throw new ContinuationStoreError("corrupt-state", `${label}[${index}].fingerprint must be a sha256 hex digest`, {
			statePath,
		});
	}
	return { id: requireString(record, "id", statePath), fingerprint };
}

function parseLockScope(value: unknown, statePath: string): ContinuationLockScope {
	const record = requireObject(value, "lockScope", statePath);
	if (record.crossNamespaceCertified !== false) {
		throw new ContinuationStoreError("corrupt-state", "lockScope.crossNamespaceCertified must be false", {
			statePath,
		});
	}
	if (record.kind === "linux-abstract-socket") {
		return {
			kind: "linux-abstract-socket",
			lockTarget: requireString(record, "lockTarget", statePath),
			networkNamespace: requireString(record, "networkNamespace", statePath),
			crossNamespaceCertified: false,
			limitation: requireString(record, "limitation", statePath),
		};
	}
	if (record.kind === "flock") {
		return { kind: "flock", lockPath: requireString(record, "lockPath", statePath), crossNamespaceCertified: false };
	}
	if (record.kind === "windows-named-mutex") {
		return {
			kind: "windows-named-mutex",
			lockTarget: requireString(record, "lockTarget", statePath),
			crossNamespaceCertified: false,
		};
	}
	throw new ContinuationStoreError("corrupt-state", `Invalid lockScope.kind ${String(record.kind)}`, { statePath });
}

function assertIdentityMatch(recorded: CanonicalPlanIdentity, current: CanonicalPlanIdentity): void {
	if (recorded.root !== current.root) {
		throw new ContinuationStoreError(
			"relocation-ambiguous",
			`Canonical worktree ${current.root} does not match recorded ${recorded.root}`,
			{ recorded, current },
		);
	}
	if (recorded.relativePath !== current.relativePath || recorded.pathSha256 !== current.pathSha256) {
		throw new ContinuationStoreError("identity-mismatch", "Plan identity does not match the recorded authority", {
			recorded,
			current,
		});
	}
}

function findCommitted(records: readonly CommittedRecord[], id: string): CommittedRecord | undefined {
	return records.find(record => record.id === id);
}

function successorActivationBarrier(state: RunStateV1): ContinuationStoreError | undefined {
	if (state.run.terminal) {
		return new ContinuationStoreError("run-terminal", "Cannot activate a successor owner for a terminal run", {
			runId: state.run.id,
		});
	}
	if (state.pendingEffects.length > 0 || state.accounting.workers.some(worker => worker.status === "live")) {
		return new ContinuationStoreError(
			"unresolved-effects",
			"Lock release permits inspection, not blind replacement dispatch; settle unresolved effects first.",
			{ pendingEffects: state.pendingEffects, workers: state.accounting.workers },
		);
	}
	if (state.intent.kind === "pause" || state.intent.kind === "stop" || state.stop !== null) {
		return new ContinuationStoreError(
			"admission-blocked",
			"Recovered owner is not admissible: pause/stop intent or stop record blocks activation.",
			{ intent: state.intent, stop: state.stop },
		);
	}
	return undefined;
}

function isRunUnsettled(state: RunStateV1): boolean {
	return (
		state.pendingEffects.length > 0 ||
		state.accounting.workers.some(worker => worker.status === "live") ||
		state.pendingHandoff !== null
	);
}

async function verifyCommittedEvidence(state: RunStateV1, io: ContinuationDurableIo): Promise<void> {
	for (const ref of state.frontier.evidence) {
		let bytes: Buffer;
		try {
			bytes = await io.readFile(ref.path);
		} catch (error) {
			throw new ContinuationStoreError("corrupt-state", `Committed evidence ${ref.path} is missing or unreadable`, {
				ref,
				error: String(error),
			});
		}
		if (bytes.byteLength < ref.byteLength) {
			throw new ContinuationStoreError(
				"corrupt-state",
				`Committed evidence ${ref.path} is shorter than byteLength`,
				{
					ref,
					actual: bytes.byteLength,
				},
			);
		}
		const actual = sha256Bytes(bytes.subarray(0, ref.byteLength));
		if (actual !== ref.sha256) {
			throw new ContinuationStoreError("corrupt-state", `Committed evidence ${ref.path} does not match sha256`, {
				ref,
				actual,
			});
		}
	}
}

async function openOwner(
	request: ContinuationOwnerRequest,
	identity: CanonicalPlanIdentity,
	controlDir: string,
	lockScope: ContinuationLockScope,
	io: ContinuationDurableIo,
): Promise<LockedContinuationOwner> {
	if (request.action === "enroll") {
		const sessionFile = path.resolve(request.initial.owner.sessionFile);
		const pendingHandoff =
			request.initial.pendingHandoff === undefined || request.initial.pendingHandoff === null
				? null
				: parsePendingHandoff(request.initial.pendingHandoff, "enroll");
		const state: RunStateV1 = {
			version: 1,
			plan: identity,
			run: { id: request.initial.runId, terminal: false },
			owner: {
				sessionId: request.initial.owner.sessionId,
				sessionFile,
				generation: 1,
			},
			intent: request.initial.intent ?? { kind: "continue" },
			frontier: {
				lastCommittedTransitionId: null,
				lastCommittedEventId: null,
				evidence: [],
			},
			pendingEffects: request.initial.pendingEffects ?? [],
			pendingHandoff,
			rejectedAttempts: [],
			stop: request.initial.stop ?? null,
			accounting: request.initial.accounting ?? {
				workers: [],
				sessions: [{ sessionId: request.initial.owner.sessionId, sessionFile }],
			},
			committedTransitions: [],
			committedEvents: [],
			lockScope,
		};
		const statePath = path.join(controlDir, CONTROL_STATE_FILENAME);
		if (await io.exists(statePath)) {
			const existing = await readCommittedState(controlDir, identity, io);
			assertLockScopeCompatible(existing.lockScope, lockScope);
			await verifyCommittedEvidence(existing, io);
			if (existing.run.id === request.initial.runId) {
				throw new ContinuationStoreError(
					"existing-authority",
					"Initial publication refused: committed state.json already exists.",
					{ statePath, runId: existing.run.id },
				);
			}
			if (!existing.run.terminal) {
				throw new ContinuationStoreError(
					"existing-authority",
					"Cannot enroll a replacement run while the committed run is nonterminal.",
					{ statePath, runId: existing.run.id, nextRunId: request.initial.runId },
				);
			}
			if (isRunUnsettled(existing)) {
				throw new ContinuationStoreError(
					"unresolved-effects",
					"Cannot enroll a replacement run until the terminal run is settled.",
					{
						pendingEffects: existing.pendingEffects,
						workers: existing.accounting.workers,
						pendingHandoff: existing.pendingHandoff,
					},
				);
			}
			await archiveTerminalRunState(controlDir, existing, io);
			await publishState(controlDir, identity.root, state, io, "replace");
			return new LockedContinuationOwner(identity, controlDir, lockScope, io, state);
		}
		await publishState(controlDir, identity.root, state, io, "create");
		return new LockedContinuationOwner(identity, controlDir, lockScope, io, state);
	}
	const state = await readCommittedState(controlDir, identity, io);
	assertLockScopeCompatible(state.lockScope, lockScope);
	if (request.expectedRunId && state.run.id !== request.expectedRunId) {
		throw new ContinuationStoreError("identity-mismatch", "Recorded run id does not match expected run id", {
			recorded: state.run.id,
			expected: request.expectedRunId,
		});
	}
	await verifyCommittedEvidence(state, io);
	return new LockedContinuationOwner(identity, controlDir, lockScope, io, state);
}

function uniqueStateTemp(controlDir: string): string {
	return path.join(controlDir, `${CONTROL_STATE_TEMP_PREFIX}${Bun.randomUUIDv7()}.tmp`);
}

async function publishState(
	controlDir: string,
	root: string,
	state: RunStateV1,
	io: ContinuationDurableIo,
	mode: "create" | "replace",
): Promise<void> {
	await assertControlPathsUnambiguous(root, controlDir, io);
	const statePath = path.join(controlDir, CONTROL_STATE_FILENAME);
	const tempPath = uniqueStateTemp(controlDir);
	const body = `${JSON.stringify(state)}\n`;
	try {
		await io.writeFileExclusive(tempPath, body, { mode: 0o600 });
		await io.fsyncFile(tempPath);
		if (mode === "create") {
			try {
				await io.link(tempPath, statePath);
			} catch (error) {
				if (hasFsCode(error, "EEXIST")) {
					throw new ContinuationStoreError(
						"existing-authority",
						"Initial publication refused: committed state.json already exists.",
						{ statePath },
					);
				}
				throw error;
			}
		} else {
			await io.rename(tempPath, statePath);
		}
	} catch (error) {
		if (error instanceof ContinuationStoreError) throw error;
		throw new ContinuationStoreError(
			"publication-failed",
			`Control publication failed before commit: ${error instanceof Error ? error.message : String(error)}`,
			{ controlDir, statePath, tempPath },
		);
	}
	try {
		await io.chmod(statePath, 0o600);
		await io.fsyncFile(statePath);
		await fsyncAncestors(controlDir, root, io);
	} catch (error) {
		throw new ContinuationStoreError(
			"publication-failed",
			`Control publication installed state.json but failed to synchronize: ${
				error instanceof Error ? error.message : String(error)
			}`,
			{ controlDir, statePath },
		);
	} finally {
		if (mode === "create") {
			try {
				await io.unlink(tempPath);
			} catch {
				// Linked bytes remain at state.json; leftover temp is not authority.
			}
		}
	}
}

async function syncEvidence(refs: readonly FileEvidenceRef[], io: ContinuationDurableIo): Promise<void> {
	for (const ref of refs) {
		const bytes = await io.readFile(ref.path);
		if (bytes.byteLength < ref.byteLength) {
			throw new ContinuationStoreError(
				"publication-failed",
				`Immutable dependency ${ref.path} is shorter than referenced byteLength ${ref.byteLength}`,
				{ ref, actual: bytes.byteLength },
			);
		}
		const actual = sha256Bytes(bytes.subarray(0, ref.byteLength));
		if (actual !== ref.sha256) {
			throw new ContinuationStoreError(
				"publication-failed",
				`Immutable dependency ${ref.path} does not match referenced sha256`,
				{ ref, actual },
			);
		}
		await io.fsyncFile(ref.path);
		await io.fsyncDir(path.dirname(ref.path));
	}
}

class LockedContinuationOwner implements ContinuationOwner {
	#state: RunStateV1;
	#queue: Promise<unknown> = Promise.resolve();
	#closed = false;
	#unusable: ContinuationStoreError | undefined;
	#stateFingerprint: string;

	constructor(
		readonly identity: CanonicalPlanIdentity,
		readonly controlDir: string,
		readonly lockScope: ContinuationLockScope,
		readonly io: ContinuationDurableIo,
		state: RunStateV1,
	) {
		this.#state = cloneState(state);
		this.#stateFingerprint = fingerprintOf(this.#state);
	}

	getState(): RunStateV1 {
		return cloneState(this.#state);
	}

	getLockScope(): ContinuationLockScope {
		return structuredClone(this.lockScope);
	}

	getControlDir(): string {
		return this.controlDir;
	}

	getIdentity(): CanonicalPlanIdentity {
		return structuredClone(this.identity);
	}

	canAdmitWork(): boolean {
		if (this.#closed || this.#unusable) return false;
		return isRecoveredOwnerAdmissible(this.#state);
	}

	commit(input: ContinuationCommit): Promise<RunStateV1> {
		return this.#serialized(() => this.#commit(structuredClone(input)));
	}

	activateOwner(input: ContinuationActivation): Promise<RunStateV1> {
		return this.#serialized(() => this.#activateOwner(structuredClone(input)));
	}

	takeOverController(input: ContinuationControllerTakeover): Promise<RunStateV1> {
		return this.#serialized(() => this.#takeOverController(structuredClone(input)));
	}

	closeOwnership(): Promise<void> {
		return this.#serialized(async () => {
			this.#closed = true;
		});
	}

	#serialized<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work, work);
		this.#queue = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	#assertMutable(): void {
		if (this.#closed) {
			throw new ContinuationStoreError(
				"owner-closed",
				"Continuation owner was released with the native lock; later mutations are rejected.",
			);
		}
		if (this.#unusable) throw this.#unusable;
	}

	async #assertHeldAuthorityStillOnDisk(): Promise<void> {
		let disk: RunStateV1;
		try {
			disk = await readCommittedState(this.controlDir, this.identity, this.io);
		} catch (error) {
			return await this.#latchUnusable(error);
		}
		if (disk.run.id !== this.#state.run.id) {
			await this.#latchUnusable(
				new ContinuationStoreError(
					"identity-mismatch",
					"On-disk run id no longer matches the held owner; explicit recovery is required.",
					{ disk: disk.run.id, held: this.#state.run.id },
				),
			);
		}
		if (disk.owner.generation !== this.#state.owner.generation) {
			await this.#latchUnusable(
				new ContinuationStoreError(
					"stale-generation",
					"On-disk owner generation no longer matches the held owner; explicit recovery is required.",
					{ disk: disk.owner.generation, held: this.#state.owner.generation },
				),
			);
		}
		if (
			disk.frontier.lastCommittedTransitionId !== this.#state.frontier.lastCommittedTransitionId ||
			disk.frontier.lastCommittedEventId !== this.#state.frontier.lastCommittedEventId
		) {
			await this.#latchUnusable(
				new ContinuationStoreError(
					"stale-frontier",
					"On-disk frontier no longer matches the held owner; explicit recovery is required.",
					{
						disk: {
							lastCommittedTransitionId: disk.frontier.lastCommittedTransitionId,
							lastCommittedEventId: disk.frontier.lastCommittedEventId,
						},
						held: {
							lastCommittedTransitionId: this.#state.frontier.lastCommittedTransitionId,
							lastCommittedEventId: this.#state.frontier.lastCommittedEventId,
						},
					},
				),
			);
		}
		if (fingerprintOf(disk) !== this.#stateFingerprint) {
			await this.#latchUnusable(
				new ContinuationStoreError(
					"stale-frontier",
					"On-disk authority changed without advancing its frontier; explicit recovery is required.",
				),
			);
		}
	}

	async #refreshInspectionState(): Promise<void> {
		try {
			this.#state = cloneState(await readCommittedState(this.controlDir, this.identity, this.io));
		} catch {
			// Keep the last known snapshot for inspection.
		}
	}

	async #latchUnusable(error: unknown): Promise<never> {
		const latched =
			error instanceof ContinuationStoreError
				? error
				: new ContinuationStoreError("publication-failed", error instanceof Error ? error.message : String(error));
		await this.#refreshInspectionState();
		this.#unusable = latched;
		throw latched;
	}

	async #commit(input: ContinuationCommit): Promise<RunStateV1> {
		this.#assertMutable();
		await this.#assertHeldAuthorityStillOnDisk();
		if (input.expectedGeneration !== this.#state.owner.generation) {
			throw new ContinuationStoreError(
				"stale-generation",
				"Commit expectedGeneration does not match owner generation",
				{
					expected: input.expectedGeneration,
					actual: this.#state.owner.generation,
				},
			);
		}
		const transitionFingerprint = fingerprintOf({
			transitionId: input.transitionId,
			eventId: input.eventId ?? null,
			patch: input.patch,
			immutableDependencies: input.immutableDependencies ?? [],
		});
		const existingTransition = findCommitted(this.#state.committedTransitions, input.transitionId);
		if (existingTransition) {
			if (existingTransition.fingerprint !== transitionFingerprint) {
				throw new ContinuationStoreError(
					"contradictory-duplicate",
					`Committed transition ${input.transitionId} was replayed with contradictory data`,
					{ transitionId: input.transitionId },
				);
			}
			return cloneState(this.#state);
		}
		if (input.eventId) {
			const existingEvent = findCommitted(this.#state.committedEvents, input.eventId);
			if (existingEvent && existingEvent.fingerprint !== transitionFingerprint) {
				throw new ContinuationStoreError(
					"contradictory-duplicate",
					`Committed event ${input.eventId} was replayed with contradictory data`,
					{ eventId: input.eventId },
				);
			}
			if (existingEvent) return cloneState(this.#state);
		}
		const deps = input.immutableDependencies ?? [];
		try {
			await syncEvidence(deps, this.io);
		} catch (error) {
			await this.#latchUnusable(error);
		}
		const next: RunStateV1 = {
			...cloneState(this.#state),
			intent: input.patch.intent ?? this.#state.intent,
			frontier: input.patch.frontier
				? {
						...cloneState(input.patch.frontier),
						lastCommittedTransitionId: input.transitionId,
						lastCommittedEventId: input.eventId ?? input.patch.frontier.lastCommittedEventId,
					}
				: {
						...cloneState(this.#state.frontier),
						lastCommittedTransitionId: input.transitionId,
						lastCommittedEventId: input.eventId ?? this.#state.frontier.lastCommittedEventId,
						evidence:
							deps.length > 0
								? [...this.#state.frontier.evidence, ...deps].map(ref => structuredClone(ref))
								: this.#state.frontier.evidence.map(ref => structuredClone(ref)),
					},
			pendingEffects: input.patch.pendingEffects ?? this.#state.pendingEffects,
			pendingHandoff:
				input.patch.pendingHandoff === undefined
					? this.#state.pendingHandoff
					: parsePendingHandoff(input.patch.pendingHandoff, "commit"),
			rejectedAttempts: input.patch.rejectedAttempts ?? this.#state.rejectedAttempts,
			stop: input.patch.stop === undefined ? this.#state.stop : input.patch.stop,
			accounting: input.patch.accounting ?? this.#state.accounting,
			run: {
				...this.#state.run,
				terminal: input.patch.runTerminal ?? this.#state.run.terminal,
			},
			committedTransitions: [
				...this.#state.committedTransitions,
				{ id: input.transitionId, fingerprint: transitionFingerprint },
			],
			committedEvents: input.eventId
				? [...this.#state.committedEvents, { id: input.eventId, fingerprint: transitionFingerprint }]
				: this.#state.committedEvents,
			lockScope: structuredClone(this.lockScope),
		};
		if (input.patch.frontier && deps.length > 0) {
			next.frontier = {
				...next.frontier,
				evidence: input.patch.frontier.evidence.map(ref => structuredClone(ref)),
			};
		}
		try {
			await publishState(this.controlDir, this.identity.root, next, this.io, "replace");
		} catch (error) {
			await this.#latchUnusable(error);
		}
		this.#state = cloneState(next);
		this.#stateFingerprint = fingerprintOf(this.#state);
		return cloneState(this.#state);
	}

	async #activateOwner(input: ContinuationActivation): Promise<RunStateV1> {
		this.#assertMutable();
		await this.#assertHeldAuthorityStillOnDisk();
		if (input.expectedGeneration !== this.#state.owner.generation) {
			throw new ContinuationStoreError(
				"stale-generation",
				"Activation expectedGeneration does not match owner generation",
				{ expected: input.expectedGeneration, actual: this.#state.owner.generation },
			);
		}
		const barrier = successorActivationBarrier(this.#state);
		if (barrier) throw barrier;
		const staged = this.#state.pendingHandoff;
		if (!staged || staged.phase !== "staged" || staged.id !== input.handoffId) {
			throw new ContinuationStoreError(
				"handoff-not-staged",
				"Successor activation requires a matching staged handoff; unstaged owner replacement is refused.",
				{ handoffId: input.handoffId, pendingHandoff: this.#state.pendingHandoff },
			);
		}
		if (
			staged.source.generation !== this.#state.owner.generation ||
			staged.source.generation !== input.expectedGeneration
		) {
			throw new ContinuationStoreError(
				"stale-generation",
				"Staged handoff source generation does not match owner generation",
				{
					source: staged.source.generation,
					owner: this.#state.owner.generation,
					expected: input.expectedGeneration,
				},
			);
		}
		if (staged.source.sessionId !== this.#state.owner.sessionId) {
			throw new ContinuationStoreError(
				"identity-mismatch",
				"Staged handoff source session does not match the committed owner",
				{ source: staged.source.sessionId, owner: this.#state.owner.sessionId },
			);
		}
		if (
			staged.source.sessionFile !== undefined &&
			path.resolve(staged.source.sessionFile) !== path.resolve(this.#state.owner.sessionFile)
		) {
			throw new ContinuationStoreError(
				"identity-mismatch",
				"Staged handoff source session file does not match the committed owner",
				{ source: staged.source.sessionFile, owner: this.#state.owner.sessionFile },
			);
		}
		if (input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== staged.policyRevision) {
			throw new ContinuationStoreError(
				"admission-blocked",
				"Activation expectedPolicyRevision does not match the staged handoff",
				{ expected: input.expectedPolicyRevision, actual: staged.policyRevision },
			);
		}
		if (input.expectedFrontier) {
			assertExpectedFrontier(
				input.expectedFrontier,
				this.#state.frontier,
				"Activation expectedFrontier does not match committed frontier",
			);
		}
		const destFile = path.resolve(staged.destination.sessionFile);
		const inputFile = path.resolve(input.session.sessionFile);
		if (staged.destination.sessionId !== input.session.sessionId || destFile !== inputFile) {
			throw new ContinuationStoreError(
				"destination-mismatch",
				"Activation session does not match the staged destination identity",
				{
					staged: { sessionId: staged.destination.sessionId, sessionFile: destFile },
					requested: { sessionId: input.session.sessionId, sessionFile: inputFile },
				},
			);
		}
		const transitionFingerprint = fingerprintOf({
			kind: "activate-owner",
			transitionId: input.transitionId,
			eventId: input.eventId ?? null,
			handoffId: input.handoffId,
			session: { sessionId: input.session.sessionId, sessionFile: inputFile },
			frontierEvidence: input.frontierEvidence,
			checkpointDependencies: input.checkpointDependencies,
			expectedFrontier: input.expectedFrontier ?? null,
			expectedPolicyRevision: input.expectedPolicyRevision ?? null,
		});
		const existingTransition = findCommitted(this.#state.committedTransitions, input.transitionId);
		if (existingTransition) {
			if (existingTransition.fingerprint !== transitionFingerprint) {
				throw new ContinuationStoreError(
					"contradictory-duplicate",
					`Committed transition ${input.transitionId} was replayed with contradictory data`,
					{ transitionId: input.transitionId },
				);
			}
			return cloneState(this.#state);
		}
		if (input.frontierEvidence.length === 0) {
			throw new ContinuationStoreError(
				"publication-failed",
				"Activation requires committed frontierEvidence for the successor checkpoint",
			);
		}
		if (!evidenceInList(input.checkpointDependencies, staged.destination.checkpoint)) {
			throw new ContinuationStoreError(
				"destination-mismatch",
				"Activation checkpointDependencies must include the immutable staged checkpoint",
				{ checkpoint: staged.destination.checkpoint },
			);
		}
		try {
			await syncEvidence(input.checkpointDependencies, this.io);
			await syncEvidence(input.frontierEvidence, this.io);
		} catch (error) {
			await this.#latchUnusable(error);
		}
		await verifyExactEvidence(staged.destination.transcript, this.io, "destination-mismatch");
		await verifyExactEvidence(staged.destination.checkpoint, this.io, "destination-mismatch");
		await verifyExactPathBytes(destFile, staged.destination.transcript, this.io);
		const next: RunStateV1 = {
			...cloneState(this.#state),
			intent: this.#state.intent.kind === "handoff" ? { kind: "continue" } : structuredClone(this.#state.intent),
			owner: {
				sessionId: input.session.sessionId,
				sessionFile: destFile,
				generation: this.#state.owner.generation + 1,
			},
			pendingHandoff: null,
			frontier: {
				...cloneState(this.#state.frontier),
				lastCommittedTransitionId: input.transitionId,
				lastCommittedEventId: input.eventId ?? this.#state.frontier.lastCommittedEventId,
				evidence: input.frontierEvidence.map(ref => structuredClone(ref)),
			},
			accounting: {
				...cloneState(this.#state.accounting),
				sessions: mergeSession(this.#state.accounting.sessions, {
					sessionId: input.session.sessionId,
					sessionFile: destFile,
				}),
			},
			committedTransitions: [
				...this.#state.committedTransitions,
				{ id: input.transitionId, fingerprint: transitionFingerprint },
			],
			committedEvents: input.eventId
				? [...this.#state.committedEvents, { id: input.eventId, fingerprint: transitionFingerprint }]
				: this.#state.committedEvents,
			lockScope: structuredClone(this.lockScope),
		};
		try {
			await publishState(this.controlDir, this.identity.root, next, this.io, "replace");
		} catch (error) {
			await this.#latchUnusable(error);
		}
		this.#state = cloneState(next);
		this.#stateFingerprint = fingerprintOf(this.#state);
		return cloneState(this.#state);
	}

	async #takeOverController(input: ContinuationControllerTakeover): Promise<RunStateV1> {
		this.#assertMutable();
		await this.#assertHeldAuthorityStillOnDisk();
		if (input.expectedGeneration !== this.#state.owner.generation) {
			throw new ContinuationStoreError(
				"stale-generation",
				"Controller takeover expectedGeneration does not match owner generation",
				{ expected: input.expectedGeneration, actual: this.#state.owner.generation },
			);
		}
		if (this.#state.run.terminal) {
			throw new ContinuationStoreError("run-terminal", "Cannot take over a terminal run", {
				runId: this.#state.run.id,
			});
		}
		assertExpectedFrontier(
			input.expectedFrontier,
			this.#state.frontier,
			"Controller takeover expectedFrontier does not match committed frontier",
		);
		const sessionFile = this.#state.owner.sessionFile;
		const transitionFingerprint = fingerprintOf({
			kind: "take-over-controller",
			transitionId: input.transitionId,
			eventId: input.eventId ?? null,
			session: { sessionId: this.#state.owner.sessionId, sessionFile },
			frontierEvidence: input.frontierEvidence,
			checkpointDependencies: input.checkpointDependencies,
			expectedFrontier: input.expectedFrontier,
		});
		const existingTransition = findCommitted(this.#state.committedTransitions, input.transitionId);
		if (existingTransition) {
			if (existingTransition.fingerprint !== transitionFingerprint) {
				throw new ContinuationStoreError(
					"contradictory-duplicate",
					`Committed transition ${input.transitionId} was replayed with contradictory data`,
					{ transitionId: input.transitionId },
				);
			}
			return cloneState(this.#state);
		}
		try {
			await syncEvidence(input.checkpointDependencies, this.io);
			await syncEvidence(input.frontierEvidence, this.io);
		} catch (error) {
			await this.#latchUnusable(error);
		}
		const next: RunStateV1 = {
			...cloneState(this.#state),
			owner: {
				sessionId: this.#state.owner.sessionId,
				sessionFile,
				generation: this.#state.owner.generation + 1,
			},
			frontier: {
				...cloneState(this.#state.frontier),
				lastCommittedTransitionId: input.transitionId,
				lastCommittedEventId: input.eventId ?? this.#state.frontier.lastCommittedEventId,
				evidence: input.frontierEvidence.map(ref => structuredClone(ref)),
			},
			committedTransitions: [
				...this.#state.committedTransitions,
				{ id: input.transitionId, fingerprint: transitionFingerprint },
			],
			committedEvents: input.eventId
				? [...this.#state.committedEvents, { id: input.eventId, fingerprint: transitionFingerprint }]
				: this.#state.committedEvents,
			lockScope: structuredClone(this.lockScope),
		};
		try {
			await publishState(this.controlDir, this.identity.root, next, this.io, "replace");
		} catch (error) {
			await this.#latchUnusable(error);
		}
		this.#state = cloneState(next);
		this.#stateFingerprint = fingerprintOf(this.#state);
		return cloneState(this.#state);
	}
}

function mergeSession(
	sessions: Array<{ sessionId: string; sessionFile: string }>,
	session: { sessionId: string; sessionFile: string },
): Array<{ sessionId: string; sessionFile: string }> {
	if (
		sessions.some(
			existing => existing.sessionId === session.sessionId && existing.sessionFile === session.sessionFile,
		)
	) {
		return sessions.map(item => structuredClone(item));
	}
	return [...sessions.map(item => structuredClone(item)), structuredClone(session)];
}

function evidenceInList(list: readonly FileEvidenceRef[], ref: FileEvidenceRef): boolean {
	const refPath = path.resolve(ref.path);
	return list.some(
		item =>
			item.kind === ref.kind &&
			item.byteLength === ref.byteLength &&
			item.sha256 === ref.sha256 &&
			path.resolve(item.path) === refPath,
	);
}

function evidenceListEqual(a: readonly FileEvidenceRef[], b: readonly FileEvidenceRef[]): boolean {
	return (
		a.length === b.length &&
		a.every(
			(item, index) =>
				item.kind === b[index].kind &&
				item.path === b[index].path &&
				item.byteLength === b[index].byteLength &&
				item.sha256 === b[index].sha256,
		)
	);
}

function assertExpectedFrontier(
	expected: {
		lastCommittedTransitionId: string | null;
		lastCommittedEventId: string | null;
		evidence?: FileEvidenceRef[];
	},
	actual: DurableFrontier,
	message: string,
): void {
	if (
		expected.lastCommittedTransitionId !== actual.lastCommittedTransitionId ||
		expected.lastCommittedEventId !== actual.lastCommittedEventId
	) {
		throw new ContinuationStoreError("stale-frontier", message, {
			expected: {
				lastCommittedTransitionId: expected.lastCommittedTransitionId,
				lastCommittedEventId: expected.lastCommittedEventId,
			},
			actual: {
				lastCommittedTransitionId: actual.lastCommittedTransitionId,
				lastCommittedEventId: actual.lastCommittedEventId,
			},
		});
	}
	if (expected.evidence && !evidenceListEqual(expected.evidence, actual.evidence)) {
		throw new ContinuationStoreError("stale-frontier", message, {
			expectedEvidence: expected.evidence,
			actualEvidence: actual.evidence,
		});
	}
}

async function verifyExactEvidence(
	ref: FileEvidenceRef,
	io: ContinuationDurableIo,
	code: ContinuationStoreErrorCode,
): Promise<void> {
	let bytes: Buffer;
	try {
		bytes = await io.readFile(ref.path);
	} catch (error) {
		throw new ContinuationStoreError(code, `Evidence ${ref.path} is missing or unreadable`, {
			ref,
			error: String(error),
		});
	}
	if (bytes.byteLength !== ref.byteLength) {
		throw new ContinuationStoreError(code, `Evidence ${ref.path} is not exactly ${ref.byteLength} bytes`, {
			ref,
			actual: bytes.byteLength,
		});
	}
	const actual = sha256Bytes(bytes);
	if (actual !== ref.sha256) {
		throw new ContinuationStoreError(code, `Evidence ${ref.path} does not match sha256`, { ref, actual });
	}
}

async function verifyExactPathBytes(filePath: string, ref: FileEvidenceRef, io: ContinuationDurableIo): Promise<void> {
	let bytes: Buffer;
	try {
		bytes = await io.readFile(filePath);
	} catch (error) {
		throw new ContinuationStoreError("missing-session-file", `Destination session file ${filePath} is missing`, {
			filePath,
			ref,
			error: String(error),
		});
	}
	if (bytes.byteLength !== ref.byteLength || sha256Bytes(bytes) !== ref.sha256) {
		throw new ContinuationStoreError(
			"destination-mismatch",
			"Destination session bytes do not match the staged transcript",
			{ filePath, ref, actualLength: bytes.byteLength },
		);
	}
}

function assertSafePathSegment(id: string, label: string): void {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
		throw new ContinuationStoreError("identity-mismatch", `${label} must be safe path segments`);
	}
}

export function checkpointPath(controlDir: string, runId: string, checkpointId: string): string {
	assertSafePathSegment(runId, "Checkpoint identities");
	assertSafePathSegment(checkpointId, "Checkpoint identities");
	return path.join(controlDir, "checkpoints", runId, `${checkpointId}.json`);
}

export function archivedRunStatePath(controlDir: string, runId: string): string {
	assertSafePathSegment(runId, "Archived run identities");
	return path.join(controlDir, ARCHIVED_RUNS_DIRNAME, runId, CONTROL_STATE_FILENAME);
}

async function archiveTerminalRunState(
	controlDir: string,
	state: RunStateV1,
	io: ContinuationDurableIo,
): Promise<void> {
	const archivePath = archivedRunStatePath(controlDir, state.run.id);
	if (await io.exists(archivePath)) {
		let raw: Buffer;
		try {
			raw = await io.readFile(archivePath);
		} catch (error) {
			throw new ContinuationStoreError("corrupt-state", `Failed to read archived terminal state: ${String(error)}`, {
				archivePath,
			});
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString("utf8"));
		} catch (error) {
			throw new ContinuationStoreError(
				"corrupt-state",
				`Archived terminal state is not valid JSON: ${String(error)}`,
				{
					archivePath,
				},
			);
		}
		const archived = parseRunState(parsed, archivePath);
		if (fingerprintOf(archived) !== fingerprintOf(state)) {
			throw new ContinuationStoreError(
				"contradictory-duplicate",
				"Archived terminal state does not match the live terminal authority",
				{ archivePath, runId: state.run.id },
			);
		}
		return;
	}
	await writeImmutableJson(archivePath, state, io);
}

export async function writeImmutableJson(
	filePath: string,
	value: unknown,
	io: ContinuationDurableIo = createNodeDurableIo(),
): Promise<FileEvidenceRef> {
	const dir = path.dirname(path.resolve(filePath));
	let existingAncestor = dir;
	while (!(await io.exists(existingAncestor))) {
		const parent = path.dirname(existingAncestor);
		if (parent === existingAncestor)
			throw new ContinuationStoreError("publication-failed", "No existing checkpoint ancestor");
		existingAncestor = parent;
	}
	await assertNoSymlinkAlong(path.parse(dir).root, dir, io);
	await io.mkdir(dir, { recursive: true, mode: 0o700 });
	await assertNoSymlinkAlong(path.parse(dir).root, dir, io);
	const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
	try {
		await io.writeFileExclusive(filePath, body, { mode: 0o600 });
	} catch (error) {
		if (hasFsCode(error, "EEXIST")) {
			throw new ContinuationStoreError(
				"existing-authority",
				`Refusing to overwrite immutable dependency ${filePath}`,
			);
		}
		throw error;
	}
	await io.fsyncFile(filePath);
	await fsyncAncestors(dir, existingAncestor, io);
	return {
		kind: "file",
		path: await io.realpath(filePath),
		byteLength: body.byteLength,
		sha256: sha256Bytes(body),
	};
}
