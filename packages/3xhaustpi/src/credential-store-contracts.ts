import { existsSync, readFileSync } from "node:fs";
import type { Credential } from "@earendil-works/pi-ai";

export type StoredCredentials = Record<string, Credential>;
export type CredentialMetadata = Record<string, { readonly type: Credential["type"]; readonly storage: "os-keyring" }>;

export interface SecureCredentialEntry {
	getPassword(): Promise<string | null | undefined>;
	setPassword(password: string): Promise<void>;
	deleteCredential(): Promise<boolean>;
}

export type SecureCredentialEntryFactory = (providerId: string) => SecureCredentialEntry;

export function parseRecord(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Credential store is not a JSON object");
	}
	return parsed as Record<string, unknown>;
}

export function parseCredentials(path: string): StoredCredentials {
	return parseRecord(path) as StoredCredentials;
}

function isCredentialType(value: unknown): value is Credential["type"] {
	return value === "api_key" || value === "oauth";
}

export function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return isCredentialType((value as { readonly type?: unknown }).type);
}

export function isCredentialMetadata(
	value: unknown,
): value is { readonly type: Credential["type"]; readonly storage: "os-keyring" } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as { readonly type?: unknown; readonly storage?: unknown };
	return isCredentialType(candidate.type) && candidate.storage === "os-keyring";
}

export function readCredentialMetadata(path: string): CredentialMetadata {
	return Object.fromEntries(
		Object.entries(parseRecord(path)).flatMap(([providerId, value]) =>
			isCredentialMetadata(value) ? [[providerId, value] as const] : [],
		),
	);
}
