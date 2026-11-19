import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { PilotManifest } from "./contract";
import { runPilot } from "./runner";

function parseArgs(args: readonly string[]): { manifest: string; output: string } {
	let manifest: string | undefined;
	let output: string | undefined;
	for (let index = 0; index < args.length; index++) {
		const flag = args[index];
		const value = args[index + 1];
		if ((flag === "--manifest" || flag === "--output") && (!value || value.startsWith("--"))) {
			throw new Error(`${flag} requires a path`);
		}
		if (flag === "--manifest") {
			manifest = value;
			index++;
			continue;
		}
		if (flag === "--output") {
			output = value;
			index++;
			continue;
		}
		throw new Error(`Unknown argument: ${flag}`);
	}
	if (!manifest || !output) throw new Error("Usage: continuation-pilot --manifest PATH --output PATH");
	return { manifest, output };
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const manifest = JSON.parse(await fs.readFile(path.resolve(args.manifest), "utf8")) as PilotManifest;
	await runPilot(manifest, path.resolve(args.output));
}

if (import.meta.main) {
	void main().catch(error => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
