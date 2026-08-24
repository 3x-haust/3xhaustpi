import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const directory = process.argv[2];
const processTreeFixture = new URL("./stubborn-process-tree-fixture.mjs", import.meta.url);
const child = fork(processTreeFixture, [directory], {
	stdio: ["ignore", "ignore", "ignore", "ipc"],
});
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = [];
let ready = false;

function respond(line) {
	const request = JSON.parse(line);
	if (request.method === "initialize") {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
	} else if (request.method === "tools/list") {
		process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n`);
	}
}

input.on("line", (line) => {
	if (ready) respond(line);
	else pending.push(line);
});
child.once("message", (message) => {
	if (message?.type !== "ready") return;
	writeFileSync(
		join(directory, "mcp-tree-ready.json"),
		JSON.stringify({
			serverPid: process.pid,
			childPid: message.childPid,
			grandchildPid: message.grandchildPid,
		}),
	);
	ready = true;
	for (const line of pending.splice(0)) respond(line);
});
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 60_000);
