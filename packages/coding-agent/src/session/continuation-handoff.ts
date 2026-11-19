import type { Context, DeveloperMessage, Model, UserMessage } from "@oh-my-pi/pi-ai";
import { daemonClientForProject, inspectProjectDaemons } from "../launch/client";
import type { DaemonCompletionNotification, DaemonSnapshot } from "../launch/protocol";
import type { ContinuationBriefing, ContinuationDiscovery, ContinuationServiceHandle } from "./continuation-briefing";
import type { ContinuationDestination } from "./continuation-policy";
import type { FileEvidenceRef } from "./continuation-store";
import type { WorkProjectionV1 } from "./continuation-work";
import { continuationCompletionSuccessorOwner } from "./launch-completion";

export type { ContinuationServiceHandle };

const LIVE_SERVICE_STATES: Record<string, true> = { running: true, ready: true };
const TERMINAL_SERVICE_STATES: Record<string, true> = { exited: true, failed: true };

/** Portable inputs captured from the actual source session after quiescence. */
export interface ContinuationHandoffInputs {
	model: Model;
	context: Context;
	retainedInstructions: readonly string[];
	roleObligations: readonly string[];
	discoveries: readonly ContinuationDiscovery[];
	queuedMessages: readonly (UserMessage | DeveloperMessage)[];
	draft: string | null;
	maxBriefingBytes: number;
	/** Nonsecret hub-managed project service identity/access. Empty when none are live. */
	services: readonly ContinuationServiceHandle[];
}

export interface ContinuationPreparationOptions {
	destination?: ContinuationDestination;
	retainedInstructions: readonly string[];
	roleObligations: readonly string[];
	discoveries: readonly ContinuationDiscovery[];
	readDraft?: () => string | null;
	maxBriefingBytes: number;
	/** Maximum time to wait for existing work; expiry cancels the transfer, not the work. */
	settlementTimeoutMs: number;
}

export interface ContinuationHandoffTicket {
	runId: string;
	id: string;
	sourceSessionId: string;
	sourceGeneration: number;
	destination: ContinuationDestination;
}

/** Created without opening AgentSession or invoking extension lifecycle hooks. */
export interface ContinuationStageSessionRequest {
	planPath: string;
	runId: string;
	sourceSessionId: string;
	generation: number;
	destination: ContinuationDestination;
	briefing: ContinuationBriefing;
	todos: WorkProjectionV1["todos"];
	queuedMessages: readonly (UserMessage | DeveloperMessage)[];
	draft: string | null;
	roleObligations: readonly string[];
	/** Nonsecret hub-managed project service handles retained for successor restoration. */
	services: readonly ContinuationServiceHandle[];
	evidencePath: string;
}

export interface ContinuationStagedSession {
	sessionId: string;
	sessionFile: string;
	/** Exact complete staged session bytes, not only an unchecked filename. */
	transcript: FileEvidenceRef;
	/** Retained prefix independent of later writes to the active session. */
	retainedTranscript: FileEvidenceRef;
}

export interface ContinuationPreparedHandoff {
	ticket: ContinuationHandoffTicket;
	session: ContinuationStagedSession;
	briefing: ContinuationBriefing;
	inputFingerprint: string;
	/** Prepare-time service handles; commit reuses these so a completion cannot change the fence. */
	services: readonly ContinuationServiceHandle[];
}

/** Durable per-daemon completion route from a source owner to the committed successor. */
export interface ContinuationCompletionRoute {
	name: string;
	id: string;
	startedAt: number;
	fromOwner: string;
	toOwner: string;
}

/** Successor-session evidence used to re-apply broker completion routing on relaunch. */
export interface ContinuationCompletionRouting {
	version: 1;
	sourceSessionId: string;
	successorSessionId: string;
	routes: ContinuationCompletionRoute[];
}

export interface ContinuationActivatedHandoff {
	runId: string;
	id: string;
	generation: number;
	sourceSessionId: string;
	sessionId: string;
	sessionFile: string;
	destination: ContinuationDestination;
	draft: string | null;
}

function continuationServiceHandle(snapshot: DaemonSnapshot): ContinuationServiceHandle {
	return {
		name: snapshot.name,
		id: snapshot.id,
		...(snapshot.pid !== undefined ? { pid: snapshot.pid } : {}),
		startedAt: snapshot.startedAt,
		...(snapshot.owner !== undefined ? { owner: snapshot.owner } : {}),
		persist: snapshot.persist,
		detached: snapshot.detached,
	};
}

function sameServiceHandle(actual: DaemonSnapshot, expected: ContinuationServiceHandle): boolean {
	return (
		Boolean(LIVE_SERVICE_STATES[actual.state]) &&
		actual.name === expected.name &&
		actual.id === expected.id &&
		actual.startedAt === expected.startedAt &&
		actual.persist === expected.persist &&
		actual.detached === expected.detached &&
		actual.owner === expected.owner &&
		actual.pid === expected.pid
	);
}

function sameCompletedServiceHandle(actual: DaemonSnapshot, expected: ContinuationServiceHandle): boolean {
	return (
		Boolean(TERMINAL_SERVICE_STATES[actual.state]) &&
		actual.name === expected.name &&
		actual.id === expected.id &&
		actual.startedAt === expected.startedAt &&
		actual.persist === expected.persist &&
		actual.detached === expected.detached &&
		actual.owner === expected.owner
	);
}

function parseContinuationServiceHandle(value: unknown, index: number): ContinuationServiceHandle {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Continuation service handles are malformed at services[${index}]`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !record.name.trim()) {
		throw new Error(`Continuation service handles are malformed at services[${index}].name`);
	}
	if (typeof record.id !== "string" || !record.id.trim()) {
		throw new Error(`Continuation service handles are malformed at services[${index}].id`);
	}
	if (!Number.isSafeInteger(record.startedAt) || (record.startedAt as number) < 0) {
		throw new Error(`Continuation service handles are malformed at services[${index}].startedAt`);
	}
	if (typeof record.persist !== "boolean" || typeof record.detached !== "boolean") {
		throw new Error(`Continuation service handles are malformed at services[${index}] persist/detached`);
	}
	if (record.pid !== undefined && (!Number.isSafeInteger(record.pid) || (record.pid as number) < 0)) {
		throw new Error(`Continuation service handles are malformed at services[${index}].pid`);
	}
	if (record.owner !== undefined && (typeof record.owner !== "string" || !record.owner.trim())) {
		throw new Error(`Continuation service handles are malformed at services[${index}].owner`);
	}
	return {
		name: record.name,
		id: record.id,
		...(record.pid !== undefined ? { pid: record.pid as number } : {}),
		startedAt: record.startedAt as number,
		...(record.owner !== undefined ? { owner: record.owner as string } : {}),
		persist: record.persist,
		detached: record.detached,
	};
}

/** Decode structured service handles retained on a staged continuation session. */
export function parseContinuationServices(value: unknown): ContinuationServiceHandle[] {
	if (value === undefined || value === null) return [];
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Continuation service handles are malformed");
	}
	const record = value as Record<string, unknown>;
	if (record.version !== 1 || !Array.isArray(record.services)) {
		throw new Error("Continuation service handles are malformed");
	}
	return record.services.map((item, index) => parseContinuationServiceHandle(item, index));
}

function parseContinuationCompletionRoute(value: unknown, index: number): ContinuationCompletionRoute {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Continuation completion routing is malformed at routes[${index}]`);
	}
	const record = value as Record<string, unknown>;
	if (typeof record.name !== "string" || !record.name.trim()) {
		throw new Error(`Continuation completion routing is malformed at routes[${index}].name`);
	}
	if (typeof record.id !== "string" || !record.id.trim()) {
		throw new Error(`Continuation completion routing is malformed at routes[${index}].id`);
	}
	if (!Number.isSafeInteger(record.startedAt) || (record.startedAt as number) < 0) {
		throw new Error(`Continuation completion routing is malformed at routes[${index}].startedAt`);
	}
	if (typeof record.fromOwner !== "string" || !record.fromOwner.trim()) {
		throw new Error(`Continuation completion routing is malformed at routes[${index}].fromOwner`);
	}
	if (typeof record.toOwner !== "string" || !record.toOwner.trim()) {
		throw new Error(`Continuation completion routing is malformed at routes[${index}].toOwner`);
	}
	return {
		name: record.name,
		id: record.id,
		startedAt: record.startedAt as number,
		fromOwner: record.fromOwner,
		toOwner: record.toOwner,
	};
}

/** Decode durable completion routing retained on a staged continuation session. */
export function parseContinuationCompletionRouting(value: unknown): ContinuationCompletionRouting | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Continuation completion routing is malformed");
	}
	const record = value as Record<string, unknown>;
	const routing = record.completionRouting;
	if (routing === undefined || routing === null) return undefined;
	if (typeof routing !== "object" || Array.isArray(routing)) {
		throw new Error("Continuation completion routing is malformed");
	}
	const body = routing as Record<string, unknown>;
	if (
		body.version !== 1 ||
		typeof body.sourceSessionId !== "string" ||
		!body.sourceSessionId.trim() ||
		typeof body.successorSessionId !== "string" ||
		!body.successorSessionId.trim() ||
		!Array.isArray(body.routes)
	) {
		throw new Error("Continuation completion routing is malformed");
	}
	return {
		version: 1,
		sourceSessionId: body.sourceSessionId,
		successorSessionId: body.successorSessionId,
		routes: body.routes.map((item, index) => parseContinuationCompletionRoute(item, index)),
	};
}

/** Build successor completion routes, carrying validated prior hops when daemon.owner stays the oldest predecessor. */
export function buildContinuationCompletionRouting(
	sourceSessionId: string,
	successorSessionId: string,
	services: readonly ContinuationServiceHandle[],
	prior?: ContinuationCompletionRouting,
): ContinuationCompletionRouting {
	const routes: ContinuationCompletionRoute[] = [];
	const seen: Record<string, true> = {};
	const add = (route: ContinuationCompletionRoute): void => {
		const key = `${route.name}\0${route.id}\0${route.startedAt}`;
		if (seen[key]) return;
		seen[key] = true;
		routes.push(route);
	};
	for (const service of services) {
		const toOwner = continuationCompletionSuccessorOwner(service.owner, sourceSessionId, successorSessionId);
		if (!service.owner || !toOwner) continue;
		add({
			name: service.name,
			id: service.id,
			startedAt: service.startedAt,
			fromOwner: service.owner,
			toOwner,
		});
	}
	if (prior && prior.successorSessionId === sourceSessionId) {
		for (const route of prior.routes) {
			if (route.toOwner !== sourceSessionId && route.toOwner !== `${sourceSessionId}-advisor`) {
				continue;
			}
			const service = services.find(
				item =>
					item.name === route.name &&
					item.id === route.id &&
					item.startedAt === route.startedAt &&
					item.owner === route.fromOwner,
			);
			if (!service) continue;
			const toOwner = continuationCompletionSuccessorOwner(route.toOwner, sourceSessionId, successorSessionId);
			if (!toOwner) continue;
			add({
				name: route.name,
				id: route.id,
				startedAt: route.startedAt,
				fromOwner: route.toOwner,
				toOwner,
			});
		}
	}
	return { version: 1, sourceSessionId, successorSessionId, routes };
}

function serviceKey(handle: ContinuationServiceHandle): string {
	return `${handle.name}\0${handle.id}\0${handle.startedAt}`;
}

/**
 * Keep prepare-time handles for the same captured generation so a live→terminal
 * completion cannot change the input fence. Newly captured services stay in the
 * set so non-terminal changes still fail the fingerprint check.
 */
export function stabilizeContinuationServices(
	prepared: readonly ContinuationServiceHandle[],
	captured: readonly ContinuationServiceHandle[],
): ContinuationServiceHandle[] {
	const capturedByKey = new Map<string, ContinuationServiceHandle>();
	for (const handle of captured) capturedByKey.set(serviceKey(handle), handle);
	const result: ContinuationServiceHandle[] = [];
	const seen: Record<string, true> = {};
	for (const handle of prepared) {
		const key = serviceKey(handle);
		seen[key] = true;
		const live = capturedByKey.get(key);
		if (live && live.startedAt === handle.startedAt && live.owner === handle.owner) {
			result.push(handle);
		} else if (!live) {
			result.push(handle);
		} else {
			result.push(live);
		}
	}
	for (const handle of captured) {
		if (!seen[serviceKey(handle)]) result.push(handle);
	}
	return result.sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.id.localeCompare(right.id) || left.startedAt - right.startedAt,
	);
}

/** Snapshot live services and terminal generations whose completion is still pending. */
export async function captureContinuationServices(projectDir: string): Promise<ContinuationServiceHandle[]> {
	const inspection = await inspectProjectDaemons(projectDir);
	if (inspection === undefined) return [];
	const handles = new Map<string, ContinuationServiceHandle>();
	for (const daemon of inspection.daemons) {
		if (!LIVE_SERVICE_STATES[daemon.state]) continue;
		const handle = continuationServiceHandle(daemon);
		handles.set(serviceKey(handle), handle);
	}
	for (const notification of inspection.pendingCompletions) {
		const handle = continuationServiceHandle(notification.daemon);
		if (!handles.has(serviceKey(handle))) handles.set(serviceKey(handle), handle);
	}
	return [...handles.values()].sort(
		(left, right) =>
			left.name.localeCompare(right.name) || left.id.localeCompare(right.id) || left.startedAt - right.startedAt,
	);
}

/** Fail closed when expected live services disappeared, restarted, or lost broker access. */
export async function verifyContinuationServices(
	projectDir: string,
	expected: readonly ContinuationServiceHandle[],
): Promise<void> {
	if (expected.length === 0) return;
	const inspection = await inspectProjectDaemons(projectDir);
	if (inspection === undefined) {
		throw new Error("Continued project service access could not be established");
	}
	for (const handle of expected) {
		if (
			!inspection.daemons.some(
				daemon => sameServiceHandle(daemon, handle) || sameCompletedServiceHandle(daemon, handle),
			) &&
			!inspection.pendingCompletions.some(notification => sameCompletedServiceHandle(notification.daemon, handle))
		) {
			throw new Error(`Live project service ${handle.name} is no longer available`);
		}
	}
}

/** Re-apply durable per-daemon completion routes on the live project broker. */
export async function routeContinuationCompletions(
	projectDir: string,
	routing: ContinuationCompletionRouting,
): Promise<void> {
	if (routing.routes.length === 0) return;
	const client = await daemonClientForProject(projectDir);
	for (const route of routing.routes) {
		await client.request({
			op: "route-completion",
			name: route.name,
			id: route.id,
			startedAt: route.startedAt,
			fromOwner: route.fromOwner,
			toOwner: route.toOwner,
		});
	}
}

/** Subscribe successor owners so routed completions ack exactly once. */
export async function bindContinuationCompletionOwners(
	projectDir: string,
	owners: readonly string[],
	sink: (notification: DaemonCompletionNotification) => Promise<void>,
): Promise<(preservePending?: boolean) => void> {
	if (owners.length === 0) return () => {};
	const client = await daemonClientForProject(projectDir);
	const unregisters = owners.map(owner => client.onCompletion(owner, sink));
	return (preservePending = true) => {
		for (const unregister of unregisters) unregister({ preservePending });
	};
}
