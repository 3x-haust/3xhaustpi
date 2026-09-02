import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type Keybinding,
	type KeybindingsConfig,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { resolveUserDataDirectory } from "./identity.ts";

declare module "@earendil-works/pi-tui" {
	interface Keybindings {
		"app.auxiliary.promote": true;
		"app.auxiliary.reviewEnd": true;
		"app.auxiliary.reviewStart": true;
		"app.clipboard.pasteImage": true;
		"app.image.openAtCursor": true;
	}
}

export const DEFAULT_APP_KEYBINDINGS = {
	...TUI_KEYBINDINGS,
	"app.auxiliary.promote": {
		defaultKeys: "ctrl+r",
		description: "Review and promote latest auxiliary answer",
	},
	"app.auxiliary.reviewStart": { defaultKeys: "home", description: "Review from start" },
	"app.auxiliary.reviewEnd": { defaultKeys: "end", description: "Review through end" },
	"app.clipboard.pasteImage": {
		defaultKeys: "ctrl+v",
		description: "Paste an image or clipboard text",
	},
	"app.image.openAtCursor": {
		defaultKeys: "ctrl+o",
		description: "Open the image under the cursor",
	},
} as const;

export const APP_KEYBINDINGS = new KeybindingsManager(DEFAULT_APP_KEYBINDINGS);
setKeybindings(APP_KEYBINDINGS);

const KEY_LABELS: Readonly<Record<string, string>> = {
	alt: "Alt",
	ctrl: "Ctrl",
	end: "End",
	enter: "Enter",
	escape: "Esc",
	home: "Home",
	pageDown: "PgDn",
	pageUp: "PgUp",
	shift: "Shift",
};
const BASE_KEYS = new Set([
	..."abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./!@#$%^&*()_|~{}:<>?+",
	"escape",
	"esc",
	"enter",
	"return",
	"tab",
	"space",
	"backspace",
	"delete",
	"insert",
	"clear",
	"home",
	"end",
	"pageUp",
	"pageDown",
	"up",
	"down",
	"left",
	"right",
	..."f1 f2 f3 f4 f5 f6 f7 f8 f9 f10 f11 f12".split(" "),
]);
const MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);

function isKeyId(value: string): value is KeyId {
	let remaining = value;
	const modifiers = new Set<string>();
	while (true) {
		const modifier = [...MODIFIERS].find((candidate) => remaining.startsWith(`${candidate}+`));
		if (!modifier) return BASE_KEYS.has(remaining);
		if (modifiers.has(modifier)) return false;
		modifiers.add(modifier);
		remaining = remaining.slice(modifier.length + 1);
	}
}

export function appKeyHint(keybinding: Keybinding): string {
	return APP_KEYBINDINGS.getKeys(keybinding)
		.map((key) =>
			key
				.split("+")
				.map((part) => KEY_LABELS[part] ?? part.toUpperCase())
				.join("+"),
		)
		.join("/");
}

export function configureTuiAppKeybindings(
	path = process.env.X3HAUSTPI_KEYBINDINGS_PATH ?? join(resolveUserDataDirectory(), "keybindings.json"),
): void {
	if (!existsSync(path)) {
		APP_KEYBINDINGS.setUserBindings({});
		return;
	}
	const info = lstatSync(path);
	if (!info.isFile() || info.isSymbolicLink() || info.size > 65_536) {
		throw new Error(`Invalid keybindings file: ${path}`);
	}
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`Invalid keybindings file: ${path}`);
	}
	const bindings: KeybindingsConfig = {};
	for (const [key, binding] of Object.entries(value)) {
		const values = typeof binding === "string" ? [binding] : binding;
		if (!Array.isArray(values)) throw new Error(`Invalid keybinding ${key}`);
		const parsed: KeyId[] = [];
		for (const entry of values) {
			if (typeof entry !== "string" || !isKeyId(entry)) throw new Error(`Invalid keybinding ${key}`);
			parsed.push(entry);
		}
		bindings[key] = typeof binding === "string" ? parsed[0] : parsed;
	}
	APP_KEYBINDINGS.setUserBindings(bindings);
}
