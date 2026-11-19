/**
 * Integration test — real broker storage and child-process exit drive routing.
 * Fake timers cannot observe meta.json durability or mixed-generation pending
 * notifications after restart.
 */
import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir, withTimeout } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient, type DaemonBrokerClient, DaemonBrokerRejectedError } from "../../src/launch/client";
import * as protocol from "../../src/launch/protocol";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonSpec,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

function spec(name: string, cwd: string, args: string[]): DaemonSpec {
	return {
		name,
		application: process.execPath,
		args,
		env: {},
		cwd,
		pty: false,
		restart: "no",
		persist: true,
		detached: false,
	};
}

async function shutdown(client: DaemonBrokerClient, broker: Promise<void>): Promise<void> {
	await client.request({ op: "shutdown" }).catch(() => undefined);
	client.close();
	await broker;
}

async function waitForPending(
	client: DaemonBrokerClient,
	name: string,
	deadlineMs = 8_000,
): Promise<DaemonCompletionNotification> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		const listed = await client.request({ op: "list" });
		if (listed.op !== "list") throw new Error(`Unexpected broker result: ${listed.op}`);
		const pending = listed.pendingCompletions?.find(item => item.daemon.name === name);
		if (pending) return pending;
		// Child exit and meta persist are driven by the real broker process, not fake timers.
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for pending completion of ${name}`);
}

async function holdPending(client: DaemonBrokerClient, owner: string): Promise<() => void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const unregister = client.onCompletion(owner, () => promise);
	return () => {
		unregister({ preservePending: true });
		resolve();
	};
}

describe("broker completion durability", () => {
	it("retains an initial completion after a transient persistence fault and broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-initial-persist-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		let client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		let broker = startBroker(projectDir, runtimeDir);
		const metaPath = path.join(runtimeDir, "daemons", "initial-fail", "meta.json");
		const rename = fs.rename;
		let injected = false;
		const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (!injected && to === metaPath) {
				const metadata = JSON.parse(await fs.readFile(from, "utf8"));
				if (metadata.pendingCompletions?.length > 0) {
					injected = true;
					throw Object.assign(new Error("Injected initial completion write failure"), { code: "EIO" });
				}
			}
			await rename(from, to);
		});
		const received = Promise.withResolvers<DaemonCompletionNotification>();
		const hold = Promise.withResolvers<void>();
		const unregister = client.onCompletion("initial-owner", notification => {
			received.resolve(notification);
			return hold.promise;
		});
		try {
			await client.request({
				op: "start",
				owner: "initial-owner",
				spec: spec("initial-fail", projectDir, ["-e", "process.exit(0)"]),
			});
			const notification = await withTimeout(
				received.promise,
				5_000,
				"Initial completion was lost after persistence failure",
			);
			expect(injected).toBe(true);
			fault.mockRestore();
			unregister({ preservePending: true });
			await shutdown(client, broker);
			hold.resolve();
			client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			broker = startBroker(projectDir, runtimeDir);
			const pending = await waitForPending(client, "initial-fail");
			expect(pending.completionId).toBe(notification.completionId);
			expect(pending.owner).toBe("initial-owner");
			expect(pending.daemon).toEqual(notification.daemon);
		} finally {
			fault.mockRestore();
			await shutdown(client, broker);
			hold.resolve();
			process.title = previousTitle;
		}
	}, 20_000);

	it("serializes a failed ACK with a concurrent completion route", async () => {
		using tempDir = TempDir.createSync("@omp-launch-ack-route-race-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const source = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const target = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const received = Promise.withResolvers<DaemonCompletionNotification>();
		const accept = Promise.withResolvers<void>();
		const holdTarget = Promise.withResolvers<void>();
		source.onCompletion("race-source", notification => {
			received.resolve(notification);
			return accept.promise;
		});
		target.onCompletion("race-target", () => holdTarget.promise);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const routeDecoded = Promise.withResolvers<void>();
		const rename = fs.rename;
		const parse = protocol.parseDaemonWireRequest;
		const metaPath = path.join(runtimeDir, "daemons", "race", "meta.json");
		let injected = false;
		const fault = spyOn(fs, "rename").mockImplementation(async (from, to) => {
			if (!injected && to === metaPath) {
				const metadata = JSON.parse(await fs.readFile(from, "utf8"));
				if (metadata.daemon.state === "exited" && metadata.pendingCompletions?.length === 0) {
					injected = true;
					entered.resolve();
					await release.promise;
					throw Object.assign(new Error("Injected ACK write failure"), { code: "EIO" });
				}
			}
			await rename(from, to);
		});
		const observeRoute = spyOn(protocol, "parseDaemonWireRequest").mockImplementation(value => {
			const request = parse(value);
			if (request.operation.op === "route-completion") routeDecoded.resolve();
			return request;
		});
		try {
			await target.request({ op: "ping" });
			await source.request({
				op: "start",
				owner: "race-source",
				spec: spec("race", projectDir, ["-e", "process.exit(0)"]),
			});
			const notification = await withTimeout(received.promise, 5_000, "Source completion was not delivered");
			accept.resolve();
			await withTimeout(entered.promise, 5_000, "ACK did not reach persistence");
			source.close();
			const routed = target.request({
				op: "route-completion",
				name: "race",
				id: notification.daemon.id,
				startedAt: notification.daemon.startedAt,
				fromOwner: "race-source",
				toOwner: "race-target",
			});
			await withTimeout(routeDecoded.promise, 5_000, "Concurrent route did not reach the broker");
			// Drain the decoded request's current microtasks before releasing the
			// held write; no elapsed-time assumption chooses the interleaving.
			await new Promise<void>(resolve => setImmediate(resolve));
			release.resolve();
			await routed;
			const metadata = JSON.parse(await fs.readFile(metaPath, "utf8"));
			expect(metadata.pendingCompletions).toEqual([
				expect.objectContaining({
					completionId: notification.completionId,
					owner: "race-target",
				}),
			]);
		} finally {
			release.resolve();
			accept.resolve();
			fault.mockRestore();
			observeRoute.mockRestore();
			source.close();
			await shutdown(target, broker);
			holdTarget.resolve();
			process.title = previousTitle;
		}
	}, 20_000);

	it("replays after ACK persistence fails and durably acknowledges the retry", async () => {
		using tempDir = TempDir.createSync("@omp-launch-ack-persist-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const daemonDir = path.join(runtimeDir, "daemons", "ack-fail");
		const replayed = Promise.withResolvers<void>();
		let deliveries = 0;
		client.onCompletion("ack-owner", async notification => {
			deliveries++;
			if (deliveries === 1) {
				await fs.chmod(daemonDir, 0o555);
				return;
			}
			const metadata = JSON.parse(await fs.readFile(path.join(daemonDir, "meta.json"), "utf8"));
			expect(metadata.pendingCompletions).toContainEqual(
				expect.objectContaining({
					completionId: notification.completionId,
				}),
			);
			await fs.chmod(daemonDir, 0o700);
			replayed.resolve();
		});
		try {
			await client.request({
				op: "start",
				owner: "ack-owner",
				spec: spec("ack-fail", projectDir, ["-e", "process.exit(0)"]),
			});
			await withTimeout(replayed.promise, 5_000, "Failed completion ACK was not replayed");
			const deadline = Date.now() + 5_000;
			for (;;) {
				const listed = await client.request({ op: "list" });
				if (listed.op !== "list") throw new Error(`Unexpected broker result: ${listed.op}`);
				const persisted = JSON.parse(await fs.readFile(path.join(daemonDir, "meta.json"), "utf8"));
				if (listed.pendingCompletions?.length === 0 && persisted.pendingCompletions?.length === 0) break;
				if (Date.now() >= deadline) throw new Error("Retried completion ACK never committed");
				await Bun.sleep(20);
			}
			const metadata = JSON.parse(await fs.readFile(path.join(daemonDir, "meta.json"), "utf8"));
			expect(metadata.pendingCompletions).toEqual([]);
			expect(deliveries).toBe(2);
		} finally {
			await fs.chmod(daemonDir, 0o700).catch(() => {});
			await shutdown(client, broker);
			process.title = previousTitle;
		}
	}, 20_000);

	it("rejects a route when required persistence fails and keeps the original owner", async () => {
		using tempDir = TempDir.createSync("@omp-launch-route-persist-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const owner = "source-owner";
		const release = await holdPending(client, owner);
		try {
			const started = await client.request({
				op: "start",
				spec: spec("persist-fail", projectDir, ["-e", "process.exit(0)"]),
				owner,
			});
			if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
			const pending = await waitForPending(client, "persist-fail");
			expect(pending.owner).toBe(owner);
			const daemonDir = path.join(runtimeDir, "daemons", "persist-fail");
			await fs.chmod(daemonDir, 0o555);
			await expect(
				client.request({
					op: "route-completion",
					name: "persist-fail",
					id: pending.daemon.id,
					startedAt: pending.daemon.startedAt,
					fromOwner: owner,
					toOwner: "successor-owner",
				}),
			).rejects.toBeInstanceOf(DaemonBrokerRejectedError);
			await fs.chmod(daemonDir, 0o700);
			const listed = await client.request({ op: "list" });
			if (listed.op !== "list") throw new Error(`Unexpected broker result: ${listed.op}`);
			expect(listed.pendingCompletions).toEqual([
				expect.objectContaining({
					completionId: pending.completionId,
					owner,
					daemon: expect.objectContaining({
						name: "persist-fail",
						id: pending.daemon.id,
						startedAt: pending.daemon.startedAt,
					}),
				}),
			]);
			const metadata: unknown = JSON.parse(await fs.readFile(path.join(daemonDir, "meta.json"), "utf8"));
			expect(metadata).toEqual(
				expect.objectContaining({
					pendingCompletions: [
						expect.objectContaining({
							completionId: pending.completionId,
							owner,
						}),
					],
				}),
			);
			expect(metadata).not.toHaveProperty("completionRoute");
		} finally {
			release();
			await shutdown(client, broker);
			process.title = previousTitle;
		}
	}, 20_000);

	it("durably routes a pending generation across broker restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-route-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		let broker = startBroker(projectDir, runtimeDir);
		const owner = "source-owner";
		const successor = "successor-owner";
		const release = await holdPending(client, owner);
		try {
			const started = await client.request({
				op: "start",
				spec: spec("persist-ok", projectDir, ["-e", "process.exit(0)"]),
				owner,
			});
			if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
			const pending = await waitForPending(client, "persist-ok");
			const routed = await client.request({
				op: "route-completion",
				name: "persist-ok",
				id: pending.daemon.id,
				startedAt: pending.daemon.startedAt,
				fromOwner: owner,
				toOwner: successor,
			});
			expect(routed).toEqual(
				expect.objectContaining({
					op: "route-completion",
					routedOwner: successor,
				}),
			);
			await shutdown(client, broker);
			const restarted = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			broker = startBroker(projectDir, runtimeDir);
			try {
				const listed = await restarted.request({ op: "list" });
				if (listed.op !== "list") throw new Error(`Unexpected broker result: ${listed.op}`);
				expect(listed.pendingCompletions).toEqual([
					expect.objectContaining({
						completionId: pending.completionId,
						owner: successor,
						daemon: expect.objectContaining({
							id: pending.daemon.id,
							startedAt: pending.daemon.startedAt,
						}),
					}),
				]);
			} finally {
				await shutdown(restarted, broker);
			}
		} finally {
			release();
			process.title = previousTitle;
		}
	}, 20_000);

	it("routes an older pending generation without rewriting a later live generation", async () => {
		using tempDir = TempDir.createSync("@omp-launch-mixed-gen-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const owner = "source-owner";
		const oldSuccessor = "old-successor";
		const liveSuccessor = "live-successor";
		const release = await holdPending(client, owner);
		try {
			const started = await client.request({
				op: "start",
				spec: spec("mixed", projectDir, ["-e", "process.stdin.resume()"]),
				owner,
			});
			if (started.op !== "start") throw new Error(`expected start, got ${started.op}`);
			const firstGeneration = {
				id: started.daemon.id,
				startedAt: started.daemon.startedAt,
			};
			await client.request({ op: "send", name: "mixed", data: "x", signal: "SIGTERM" });
			const pending = await waitForPending(client, "mixed");
			expect(pending.daemon.id).toBe(firstGeneration.id);
			expect(pending.daemon.startedAt).toBe(firstGeneration.startedAt);

			const restarted = await client.request({ op: "restart", name: "mixed" });
			if (restarted.op !== "restart") throw new Error(`expected restart, got ${restarted.op}`);
			expect(restarted.daemon.id).toBe(firstGeneration.id);
			expect(restarted.daemon.startedAt).not.toBe(firstGeneration.startedAt);
			const liveGeneration = {
				id: restarted.daemon.id,
				startedAt: restarted.daemon.startedAt,
			};

			const listedBefore = await client.request({ op: "list" });
			if (listedBefore.op !== "list") throw new Error(`Unexpected broker result: ${listedBefore.op}`);
			expect(listedBefore.pendingCompletions).toEqual([
				expect.objectContaining({
					owner,
					daemon: expect.objectContaining(firstGeneration),
				}),
			]);
			expect(listedBefore.daemons[0]).toEqual(
				expect.objectContaining({
					name: "mixed",
					...liveGeneration,
				}),
			);

			await client.request({
				op: "route-completion",
				name: "mixed",
				id: firstGeneration.id,
				startedAt: firstGeneration.startedAt,
				fromOwner: owner,
				toOwner: oldSuccessor,
			});
			const afterOld = await client.request({ op: "list" });
			if (afterOld.op !== "list") throw new Error(`Unexpected broker result: ${afterOld.op}`);
			expect(afterOld.pendingCompletions).toEqual([
				expect.objectContaining({
					owner: oldSuccessor,
					daemon: expect.objectContaining(firstGeneration),
				}),
			]);

			await client.request({
				op: "route-completion",
				name: "mixed",
				id: liveGeneration.id,
				startedAt: liveGeneration.startedAt,
				fromOwner: owner,
				toOwner: liveSuccessor,
			});
			const afterLive = await client.request({ op: "list" });
			if (afterLive.op !== "list") throw new Error(`Unexpected broker result: ${afterLive.op}`);
			expect(afterLive.pendingCompletions).toEqual([
				expect.objectContaining({
					owner: oldSuccessor,
					daemon: expect.objectContaining(firstGeneration),
				}),
			]);
			await expect(
				client.request({
					op: "route-completion",
					name: "mixed",
					id: firstGeneration.id,
					startedAt: firstGeneration.startedAt,
					fromOwner: owner,
					toOwner: liveSuccessor,
				}),
			).rejects.toBeInstanceOf(DaemonBrokerRejectedError);

			await shutdown(client, broker);
			const recoveredClient = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
			const recoveredBroker = startBroker(projectDir, runtimeDir);
			try {
				const recovered = await recoveredClient.request({ op: "list" });
				if (recovered.op !== "list") throw new Error(`Unexpected broker result: ${recovered.op}`);
				expect(recovered.pendingCompletions).toEqual([
					expect.objectContaining({
						owner: oldSuccessor,
						daemon: expect.objectContaining(firstGeneration),
					}),
				]);
				await recoveredClient.request({
					op: "route-completion",
					name: "mixed",
					id: firstGeneration.id,
					startedAt: firstGeneration.startedAt,
					fromOwner: oldSuccessor,
					toOwner: "recovered-successor",
				});
				const rerouted = await recoveredClient.request({ op: "list" });
				if (rerouted.op !== "list") throw new Error(`Unexpected broker result: ${rerouted.op}`);
				expect(rerouted.pendingCompletions).toEqual([
					expect.objectContaining({
						owner: "recovered-successor",
						daemon: expect.objectContaining(firstGeneration),
					}),
				]);
			} finally {
				await shutdown(recoveredClient, recoveredBroker);
			}
		} finally {
			release();
			await shutdown(client, broker);
			process.title = previousTitle;
		}
	}, 30_000);
});
