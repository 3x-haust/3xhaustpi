import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DesktopHelperRuntime } from "./desktop-runtime-contracts.ts";

const runtimeRoot = dirname(fileURLToPath(import.meta.url));
const helperPaths = {
	darwin: join(runtimeRoot, "macos", "ax_host.jxa"),
	win32: join(runtimeRoot, "windows", "uia_host.ps1"),
	linux: join(runtimeRoot, "linux", "atspi_host.py"),
} as const;
const osascriptPath = "/usr/bin/osascript";
const linuxPythonPath = "/usr/bin/python3";

function windowsPowerShellPath(): string {
	const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
	return join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function resolveDesktopHelper(platform: NodeJS.Platform = process.platform): DesktopHelperRuntime | undefined {
	if (platform === "darwin" && existsSync(osascriptPath) && existsSync(helperPaths.darwin)) {
		return {
			platform,
			command: osascriptPath,
			args: ["-l", "JavaScript", helperPaths.darwin],
			helper: "macOS System Events accessibility",
			env: { PATH: "/usr/bin:/bin" },
		};
	}
	if (platform === "win32") {
		const command = windowsPowerShellPath();
		if (existsSync(command) && existsSync(helperPaths.win32)) {
			return {
				platform,
				command,
				args: [
					"-NoLogo",
					"-NoProfile",
					"-NonInteractive",
					"-ExecutionPolicy",
					"Bypass",
					"-File",
					helperPaths.win32,
				],
				helper: "Windows UI Automation",
				env: { SystemRoot: process.env.SystemRoot || process.env.WINDIR || "C:\\Windows" },
			};
		}
	}
	if (platform === "linux" && existsSync(linuxPythonPath) && existsSync(helperPaths.linux)) {
		return {
			platform,
			command: linuxPythonPath,
			args: ["-I", helperPaths.linux],
			helper: "Linux AT-SPI accessibility",
			env: {
				PATH: "/usr/bin:/bin",
				...(process.env.DBUS_SESSION_BUS_ADDRESS
					? { DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS }
					: {}),
				...(process.env.XDG_RUNTIME_DIR ? { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR } : {}),
				...(process.env.DISPLAY ? { DISPLAY: process.env.DISPLAY } : {}),
				...(process.env.WAYLAND_DISPLAY ? { WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY } : {}),
			},
		};
	}
	return undefined;
}
