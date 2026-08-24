import { fork } from "node:child_process";

const role = process.argv[2] ?? "child";

process.on("SIGTERM", () => {});

if (role === "grandchild") {
	process.send?.({ type: "ready", grandchildPid: process.pid });
} else {
	const grandchild = fork(import.meta.filename, ["grandchild"], {
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	grandchild.once("message", (message) => {
		if (message?.type === "ready") {
			process.send?.({ type: "ready", childPid: process.pid, grandchildPid: message.grandchildPid });
		}
	});
}

setInterval(() => {}, 60_000);
