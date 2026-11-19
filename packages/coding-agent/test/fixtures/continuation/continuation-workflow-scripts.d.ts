type WorkProjectionV1 = import("@oh-my-pi/pi-coding-agent/session/continuation-work").WorkProjectionV1;

/** File evidence returned by Sjujperpowers recovery helpers. */
interface ContinuationWorkflowFileEvidence {
	kind: "file";
	path: string;
	byteLength: number;
	sha256: string;
}

interface ContinuationWorkflowShowIssue {
	root: string;
	project: string;
	ref: string;
}

declare module "*materialize-plan.mjs" {
	export function materializePlan(args: {
		root: string;
		planPath: string;
		markdown: string;
		config: unknown;
		runKata: (args: string[]) => Promise<unknown>;
	}): Promise<{
		parent: { ref: string; created: boolean };
		children: Array<{ task: number; ref: string; created: boolean }>;
	}>;
}

declare module "*record-recovery.mjs" {
	export function recordRecovery(args: {
		root: string;
		planPath: string;
		event: unknown;
		config: unknown;
		showIssue?: (args: ContinuationWorkflowShowIssue) => Promise<unknown>;
		runtimeCheck?: boolean;
	}): Promise<{
		acknowledged: boolean;
		revision: number;
		eventId: string;
		snapshotEvidence: ContinuationWorkflowFileEvidence;
		retained: unknown;
		evidence: ContinuationWorkflowFileEvidence[];
		progressPath: string;
		snapshot: unknown;
	}>;
}

declare module "*export-recovery.mjs" {
	export function exportRecovery(args: {
		root: string;
		planPath: string;
		workflow?: string;
		showIssue?: (args: ContinuationWorkflowShowIssue) => Promise<unknown>;
		config: unknown;
		runtimeCheck?: boolean;
	}): Promise<WorkProjectionV1>;
}

declare module "*recovery-lib.mjs" {
	export function workspaceDir(root: string, relativePath: string): string;
	export function fileEvidence(path: string, byteLength?: number): Promise<ContinuationWorkflowFileEvidence>;
}
