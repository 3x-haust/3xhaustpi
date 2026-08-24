import { fork } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const directory = process.argv[2];
const role = process.argv[3] ?? "child";

if (!directory) throw new Error("Process-tree fixture requires an output directory.");

function terminate(name) {
	writeFileSync(join(directory, `${name}-terminated`), String(process.pid));
	process.exit(0);
}

process.once("SIGTERM", () => terminate(role));

if (role === "grandchild") {
	process.send?.({ type: "ready", grandchildPid: process.pid });
} else {
	const grandchild = fork(import.meta.filename, [directory, "grandchild"], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	grandchild.once("message", (message) => {
		if (message?.type !== "ready") return;
		const tree = { childPid: process.pid, grandchildPid: message.grandchildPid };
		if (process.send) process.send({ type: "ready", ...tree });
		else writeFileSync(join(directory, "tree-ready.json"), JSON.stringify(tree));
	});
}

setInterval(() => {}, 60_000);
