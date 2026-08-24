import { lstatSync, mkdirSync, readFileSync, realpathSync, type Stats, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { PatchProposal } from "@3xhaust/semantic-contract";
import type { DescriptorWrite } from "./coding-runtime-patch-descriptor.ts";
import { applyPatchTransaction, type TransactionalPatchFile } from "./coding-runtime-patch-transaction.ts";
import { displayName, type ProjectDocument } from "./project-snapshot.ts";

type SecureProjectRoot = { readonly path: string; readonly device: number; readonly inode: number };

export interface PreparedPatchFile extends TransactionalPatchFile {
	readonly document: ProjectDocument;
}

function secureProjectRoot(projectRoot: string): SecureProjectRoot {
	const path = realpathSync(projectRoot);
	const stats = statSync(path);
	if (!stats.isDirectory()) throw new Error(`Project root is not a directory: ${projectRoot}`);
	return { path, device: stats.dev, inode: stats.ino };
}

function isPathContained(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return fromRoot === "" || (!isAbsolute(fromRoot) && fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`));
}

function verifyProjectRoot(root: SecureProjectRoot): void {
	const stats = statSync(root.path);
	if (realpathSync(root.path) !== root.path || stats.dev !== root.device || stats.ino !== root.inode) {
		throw new Error("Project root changed while applying the patch");
	}
}

function lstatIfExists(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function verifyPatchPath(root: SecureProjectRoot, path: string): Stats | undefined {
	verifyProjectRoot(root);
	if (!isPathContained(root.path, path) || path === root.path) {
		throw new Error(`Patch target escapes the project: ${path}`);
	}
	let current = root.path;
	let targetStats: Stats | undefined;
	for (const component of relative(root.path, path).split(sep)) {
		current = join(current, component);
		const stats = lstatIfExists(current);
		if (!stats) break;
		if (stats.isSymbolicLink()) throw new Error(`Patch target contains a symbolic link: ${current}`);
		if (current === path && stats.isFile() && stats.nlink !== 1) {
			throw new Error(`Patch target has multiple links: ${current}`);
		}
		targetStats = current === path ? stats : undefined;
	}
	let existing = path;
	while (!lstatIfExists(existing) && existing !== root.path) existing = dirname(existing);
	if (!isPathContained(root.path, realpathSync(existing))) {
		throw new Error(`Patch target resolves outside the project: ${path}`);
	}
	return targetStats;
}

function ensurePatchParent(root: SecureProjectRoot, path: string): void {
	const fromRoot = relative(root.path, dirname(path));
	let current = root.path;
	for (const component of fromRoot === "" ? [] : fromRoot.split(sep)) {
		current = join(current, component);
		if (!verifyPatchPath(root, current)) mkdirSync(current, { mode: 0o755 });
		if (!verifyPatchPath(root, current)?.isDirectory())
			throw new Error(`Patch parent is not a directory: ${current}`);
	}
}

function patchPath(root: SecureProjectRoot, relativePath: string): string {
	const path = resolve(root.path, relativePath);
	verifyPatchPath(root, path);
	return path;
}

export function preparePatchedFiles(
	projectRoot: string,
	proposal: PatchProposal,
	documents: ReadonlyMap<string, ProjectDocument>,
): readonly PreparedPatchFile[] {
	const secureRoot = secureProjectRoot(projectRoot);
	const pending = new Map<string, PreparedPatchFile>();
	for (const edit of proposal.edits) {
		const document = documents.get(edit.documentId);
		if (!document) throw new Error(`Patch references undisclosed document ${edit.documentId}`);
		const previous = pending.get(edit.documentId);
		const path = patchPath(secureRoot, document.relativePath);
		const existedBefore = previous?.existedBefore ?? verifyPatchPath(secureRoot, path) !== undefined;
		const current =
			previous?.after ??
			(existedBefore
				? readFileSync(path, "utf8")
				: document.virtual
					? document.content
					: (() => {
							throw new Error(`Patch target is unavailable for ${displayName(document)}`);
						})());
		const first = current.indexOf(edit.oldText);
		if (first < 0) throw new Error(`Patch oldText is stale for ${displayName(document)}`);
		if (current.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
			throw new Error(`Patch oldText is ambiguous for ${displayName(document)}`);
		}
		pending.set(edit.documentId, {
			document,
			before: previous?.before ?? current,
			after: `${current.slice(0, first)}${edit.newText}${current.slice(first + edit.oldText.length)}`,
			existedBefore,
		});
	}
	return [...pending.values()];
}

export function applyPreparedFiles(projectRoot: string, files: readonly PreparedPatchFile[], write?: DescriptorWrite) {
	const root = secureProjectRoot(projectRoot);
	applyPatchTransaction(
		files,
		{
			path: (relativePath) => patchPath(root, relativePath),
			verify: (path) => verifyPatchPath(root, path),
			ensureParent: (path) => ensurePatchParent(root, path),
		},
		write,
	);
}
