/**
 * Sandbox containment probe for the continuation local check.
 *
 * Imports only standard/Bun APIs (never OMP). Fails closed if the parent-home
 * sentinel is readable, the controlled forbidden URL is reachable, scratch
 * paths are not under the builder temp, or credential-like env vars are set.
 * A denied forbidden connection is recorded as non-reachability — it is not
 * proof the parent listener exists.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
	console.error(`containment-probe: ${message}`);
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

	const home = path.resolve(requireEnv("HOME"));
	if (!isUnderBuilderTemp(os.homedir())) {
		fail("os.homedir() is not under the builder temp");
	}
	if (!isUnderBuilderTemp(os.tmpdir())) {
		fail("os.tmpdir() is not under the builder temp");
	}

	if (
		(home === "/root" || home.startsWith("/home/") || home.startsWith("/Users/")) &&
		!isUnderBuilderTemp(home)
	) {
		fail(`HOME looks like a real user home: ${home}`);
	}
}

function assertSentinelUnreadable(sentinel: string): void {
	const resolved = path.resolve(sentinel);
	const home = path.resolve(requireEnv("HOME"));
	if (isPathInside(home, resolved)) {
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

async function assertForbiddenUnreachable(urlText: string): Promise<void> {
	let parsed: URL;
	try {
		parsed = new URL(urlText);
	} catch {
		fail("CONTINUATION_FORBIDDEN_URL is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		fail("CONTINUATION_FORBIDDEN_URL must be http(s)");
	}

	try {
		const response = await fetch(parsed, {
			method: "GET",
			redirect: "manual",
			signal: AbortSignal.timeout(3000),
		});
		fail(`forbidden endpoint was reachable (HTTP ${response.status})`);
	} catch {
		// Connection denied/timeout/unreachability is the required outcome.
		// It is not evidence that the parent listener exists.
	}
}

async function assertLocalhostWorks(): Promise<{ url: string }> {
	const token = "continuation-localhost-ok";
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(): Response {
			return new Response(token, { status: 200 });
		},
	});
	try {
		const url = `http://127.0.0.1:${server.port}/`;
		const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(3000) });
		const body = await response.text();
		if (!response.ok || body !== token) {
			fail(`in-sandbox localhost server did not respond as expected (HTTP ${response.status})`);
		}
		return { url };
	} finally {
		server.stop(true);
	}
}

async function main(): Promise<void> {
	const sentinel = requireEnv("CONTINUATION_PARENT_SENTINEL");
	const forbiddenUrl = requireEnv("CONTINUATION_FORBIDDEN_URL");

	if (process.platform !== "linux") fail("this containment check requires Linux");
	if (Object.values(os.networkInterfaces()).flat().some(iface => iface && !iface.internal)) {
		fail("a non-loopback network interface is visible");
	}
	assertNoCredentialEnv();
	assertScratchPathsAreTemporary();
	assertSentinelUnreadable(sentinel);
	await assertForbiddenUnreachable(forbiddenUrl);
	const localhost = await assertLocalhostWorks();

	process.stdout.write(
		`${JSON.stringify(
			{
				ok: true,
				platform: process.platform,
				arch: process.arch,
				sentinelReadable: false,
				forbiddenReachable: false,
				externalNetworkInterface: false,
				localhostOk: true,
				localhostUrl: localhost.url,
				limitations: [
					"A denied connection to CONTINUATION_FORBIDDEN_URL is not proof the parent listener exists.",
					"Parent verifies the controlled endpoint outside the sandbox.",
				],
			},
			null,
			2,
		)}\n`,
	);
}

await main();
