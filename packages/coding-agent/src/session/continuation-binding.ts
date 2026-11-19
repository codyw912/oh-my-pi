import type { ToolExecutionBoundary } from "@oh-my-pi/pi-agent-core";
import type { DeliveryAcceptanceHandler, JobAdmissionHandler } from "../async/job-manager";
import type { ContinuationDestination, ContinuationRole } from "./continuation-policy";
import type { ContinuationRequestBoundary } from "./continuation-request";
import type { SessionManager } from "./session-manager";
import type {
	ContinuationActivatedHandoff,
	ContinuationHandoffInputs,
	ContinuationHandoffTicket,
	ContinuationPreparedHandoff,
} from "./continuation-handoff";

export type AdmissionOutcome =
	| { kind: "allow" }
	| { kind: "handoff-required"; reason: string; provider: string; account: string }
	| { kind: "defer"; reason: string }
	| { kind: "stop"; reason: string; attention: boolean };

/** Explicit SDK enrollment only. Registration of a workflow does not create a run. */
export interface ContinuationBindingFactory {
	bindSession(manager: SessionManager, role: ContinuationRole): ContinuationSessionBinding;
}

/** One actor at one owner generation. Children inherit this generation, never a live pointer to a replacement owner. */
export interface ContinuationSessionBinding {
	readonly role: ContinuationRole;
	readonly factory: ContinuationBindingFactory;
	readonly requestBoundary: ContinuationRequestBoundary;
	readonly toolBoundary: ToolExecutionBoundary;
	readonly admitJob: JobAdmissionHandler;
	readonly acceptDeliveries: DeliveryAcceptanceHandler;
	readonly handoff?: {
		candidates(): Promise<ContinuationDestination[]>;
		begin(destination?: ContinuationDestination): Promise<ContinuationHandoffTicket>;
		prepare(
			ticket: ContinuationHandoffTicket,
			inputs: ContinuationHandoffInputs,
		): Promise<ContinuationPreparedHandoff>;
		commit(
			prepared: ContinuationPreparedHandoff,
			inputs: ContinuationHandoffInputs,
		): Promise<ContinuationActivatedHandoff>;
		cancel(ticket: ContinuationHandoffTicket, reason: string, rejectDestination?: boolean): Promise<void>;
		adopt(manager: SessionManager): ContinuationSessionBinding;
	};
	forRole(role: ContinuationRole, identity: string): ContinuationSessionBinding;
	/** Called before ordinary fallback/reset waiting. Non-allow outcomes must not enter those paths. */
	beforeRecovery(error?: unknown): Promise<AdmissionOutcome>;
	/** Persist only explicit receipts; never await a callback that includes the caller. */
	barrier(): Promise<void>;
	/** Existing destructive session operations need committed run authority for their target. */
	assertSessionTransition(action: string, targetSessionFile?: string): void;
	/** Retire this actor; only disposal of the current primary may release the run lock. */
	dispose(): Promise<void>;
}
