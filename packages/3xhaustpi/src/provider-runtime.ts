import type {
	Api,
	AuthInteraction,
	AuthType,
	Credential,
	CredentialInfo,
	CredentialStore,
	Model,
	Models,
	MutableModels,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { FileCredentialStore, SystemCredentialStore, systemCredentialStoreName } from "./credential-store.ts";
import { ACTIVE_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_SERVICE, resolveAuthPath } from "./identity.ts";
import { codexCredentialStorageId } from "./provider-accounts.ts";
import { answerAuthPrompt, notifyAuth } from "./provider-auth-prompt.ts";
import { sanitizeTerminalText } from "./terminal-sanitizer.ts";

export {
	type AuthPromptInput,
	type AuthPromptQuestionOptions,
	type AuthPromptTerminal,
	answerAuthPrompt,
	createTerminalAuthPromptInput,
} from "./provider-auth-prompt.ts";

export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-5.6-terra";
export const AUTH_PATH = resolveAuthPath();
export const CREDENTIAL_BACKEND = process.env.X3HAUSTPI_CREDENTIAL_BACKEND === "file" ? "file" : "system";
const MODEL_CONTEXT_WINDOWS = new Map<string, number | undefined>();

export function modelContextWindow(provider: string, modelId: string): number | undefined {
	const key = `${provider}\u0000${modelId}`;
	if (MODEL_CONTEXT_WINDOWS.has(key)) return MODEL_CONTEXT_WINDOWS.get(key);
	const contextWindow = builtinModels().getModel(provider, modelId)?.contextWindow;
	const measured =
		typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
			? contextWindow
			: undefined;
	MODEL_CONTEXT_WINDOWS.set(key, measured);
	return measured;
}

export interface ProviderCredentialOverride {
	readonly providerId: string;
	readonly credential: Credential;
}

export interface ProviderAuthMethod {
	readonly type: AuthType;
	readonly label: string;
	readonly interactive: boolean;
}

export interface ProviderStatus {
	readonly id: string;
	readonly name: string;
	readonly modelCount: number;
	readonly modelIds: readonly string[];
	readonly authMethods: readonly ProviderAuthMethod[];
	readonly configured: boolean;
	readonly credentialType?: AuthType;
	readonly source?: string;
	readonly error?: string;
}

class OverlayCredentialStore implements CredentialStore {
	private readonly base: CredentialStore;
	private readonly providerId: string;
	private credential: Credential | undefined;

	constructor(base: CredentialStore, override: ProviderCredentialOverride) {
		this.base = base;
		this.providerId = override.providerId;
		this.credential = override.credential;
	}

	read(providerId: string): Promise<Credential | undefined> {
		if (providerId === this.providerId) return Promise.resolve(this.credential);
		return this.base.read(providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const existing = (await this.base.list()).filter(({ providerId }) => providerId !== this.providerId);
		return this.credential ? [...existing, { providerId: this.providerId, type: this.credential.type }] : existing;
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		if (providerId === this.providerId) {
			return fn(this.credential).then((next) => {
				if (next !== undefined) this.credential = next;
				return this.credential;
			});
		}
		return this.base.modify(providerId, fn);
	}

	delete(providerId: string): Promise<void> {
		if (providerId === this.providerId) {
			this.credential = undefined;
			return Promise.resolve();
		}
		return this.base.delete(providerId);
	}
}

class ScopedCodexCredentialStore implements CredentialStore {
	private readonly base: CredentialStore;
	private readonly storageId: string;

	constructor(base: CredentialStore, accountId: string) {
		this.base = base;
		this.storageId = codexCredentialStorageId(accountId);
	}

	read(providerId: string): Promise<Credential | undefined> {
		return this.base.read(providerId === "openai-codex" ? this.storageId : providerId);
	}

	async list(): Promise<readonly CredentialInfo[]> {
		const entries = await this.base.list();
		const scoped = entries.find(({ providerId }) => providerId === this.storageId);
		return [
			...entries.filter(
				({ providerId }) => providerId !== "openai-codex" && !providerId.startsWith("openai-codex.account."),
			),
			...(scoped ? [{ providerId: "openai-codex", type: scoped.type }] : []),
		];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		return this.base.modify(providerId === "openai-codex" ? this.storageId : providerId, fn);
	}

	delete(providerId: string): Promise<void> {
		return this.base.delete(providerId === "openai-codex" ? this.storageId : providerId);
	}
}

function credentialFromWire(value: string): Credential {
	if (!value.startsWith("{")) return { type: "api_key", key: value };
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		throw new Error("Provider credential envelope is invalid");
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Provider credential envelope is invalid");
	}
	const candidate = parsed as Record<string, unknown>;
	if (
		candidate.type === "api_key" &&
		(candidate.key === undefined || typeof candidate.key === "string") &&
		(candidate.env === undefined ||
			(typeof candidate.env === "object" && candidate.env !== null && !Array.isArray(candidate.env)))
	) {
		return parsed as Credential;
	}
	if (
		candidate.type === "oauth" &&
		typeof candidate.access === "string" &&
		typeof candidate.refresh === "string" &&
		typeof candidate.expires === "number" &&
		Number.isFinite(candidate.expires)
	) {
		return parsed as Credential;
	}
	throw new Error("Provider credential envelope is invalid");
}

export function providerCredentialOverride(providerId: string, value: string): ProviderCredentialOverride {
	return { providerId, credential: credentialFromWire(value) };
}

export function credentialStoreDescription(): string {
	return CREDENTIAL_BACKEND === "file"
		? `private file ${AUTH_PATH}`
		: `${systemCredentialStoreName()} · metadata ${AUTH_PATH}`;
}

export function scopedCredentialStore(base: CredentialStore, accountId: string | undefined): CredentialStore {
	if (!accountId || accountId.startsWith("provider:")) return base;
	if (!accountId.startsWith("openai-codex:") || accountId.length === "openai-codex:".length) {
		throw new Error(`Invalid provider account ID: ${accountId}`);
	}
	return new ScopedCodexCredentialStore(base, accountId.slice("openai-codex:".length));
}

export function createCredentialStore(accountId?: string): CredentialStore {
	const base =
		CREDENTIAL_BACKEND === "file"
			? new FileCredentialStore(AUTH_PATH)
			: new SystemCredentialStore(AUTH_PATH, {
					service: ACTIVE_KEYCHAIN_SERVICE,
					legacyService: LEGACY_KEYCHAIN_SERVICE,
				});
	return scopedCredentialStore(base, accountId);
}

export function createProviderRuntime(override?: ProviderCredentialOverride, accountId?: string): MutableModels {
	const base = createCredentialStore(accountId);
	return builtinModels({ credentials: override ? new OverlayCredentialStore(base, override) : base });
}

function terminalAuthInteraction(): AuthInteraction {
	return { prompt: answerAuthPrompt, notify: notifyAuth };
}

export async function loginProvider(
	providerId = DEFAULT_PROVIDER,
	authType?: AuthType,
	interaction: AuthInteraction = terminalAuthInteraction(),
): Promise<void> {
	const models = createProviderRuntime();
	const provider = models.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const type = authType ?? (provider.auth.oauth ? "oauth" : "api_key");
	const method = type === "oauth" ? provider.auth.oauth : provider.auth.apiKey;
	if (!method) throw new Error(`${provider.name} does not support ${type === "oauth" ? "OAuth" : "API key"} login`);
	if (type === "api_key" && !method.login) {
		throw new Error(`${provider.name} uses ambient credentials and has no interactive API-key login`);
	}
	await models.login(providerId, type, interaction);
	console.log(sanitizeTerminalText(`Credentials saved to ${credentialStoreDescription()}`));
}

export async function collectProviderStatuses(
	models: Models = createProviderRuntime(),
): Promise<readonly ProviderStatus[]> {
	return Promise.all(
		models.getProviders().map(async (provider): Promise<ProviderStatus> => {
			const authMethods: ProviderAuthMethod[] = [
				...(provider.auth.oauth
					? [{ type: "oauth" as const, label: provider.auth.oauth.name, interactive: true }]
					: []),
				...(provider.auth.apiKey
					? [
							{
								type: "api_key" as const,
								label: provider.auth.apiKey.name,
								interactive: provider.auth.apiKey.login !== undefined,
							},
						]
					: []),
			];
			try {
				const credential = await models.checkAuth(provider.id);
				return {
					id: provider.id,
					name: provider.name,
					modelCount: provider.getModels().length,
					modelIds: provider.getModels().map(({ id }) => id),
					authMethods,
					configured: credential !== undefined,
					...(credential?.type ? { credentialType: credential.type } : {}),
					...(credential?.source ? { source: credential.source } : {}),
				};
			} catch (cause) {
				return {
					id: provider.id,
					name: provider.name,
					modelCount: provider.getModels().length,
					modelIds: provider.getModels().map(({ id }) => id),
					authMethods,
					configured: false,
					error: cause instanceof Error ? cause.message : String(cause),
				};
			}
		}),
	);
}

export const providerStatuses = collectProviderStatuses;

export function resolveModel(models: Models, provider = DEFAULT_PROVIDER, modelId = DEFAULT_MODEL): Model<Api> {
	const model = models.getModel(provider, modelId);
	if (!model) throw new Error(`Model is unavailable: ${provider}/${modelId}`);
	return model;
}
