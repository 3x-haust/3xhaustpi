import { closeSync, fstatSync, ftruncateSync, readSync, type Stats, writeSync } from "node:fs";

export interface OpenPatchFile {
	readonly existedBefore: boolean;
	readonly path: string;
	readonly descriptor: number;
	readonly stats: Stats;
	readonly before: Buffer;
	readonly after: Buffer;
	rollbackRequired: boolean;
	rollbackContent: Buffer;
}

export type DescriptorWrite = (
	descriptor: number,
	data: Buffer,
	offset: number,
	length: number,
	position: number,
) => number;

export function readPatchDescriptor(descriptor: number): Buffer {
	const data = Buffer.alloc(fstatSync(descriptor).size);
	let offset = 0;
	while (offset < data.length) {
		const count = readSync(descriptor, data, offset, data.length - offset, offset);
		if (count === 0) return data.subarray(0, offset);
		offset += count;
	}
	return data;
}

export function writePatchDescriptor(
	descriptor: number,
	data: Buffer,
	write: DescriptorWrite = writeSync,
	onProgress?: (content: Buffer) => void,
): void {
	ftruncateSync(descriptor, 0);
	onProgress?.(data.subarray(0, 0));
	let offset = 0;
	while (offset < data.length) {
		const written = write(descriptor, data, offset, data.length - offset, offset);
		if (written === 0) throw new Error("Patch target write made no progress");
		offset += written;
		onProgress?.(data.subarray(0, offset));
	}
}

export function closePatchFiles(files: readonly OpenPatchFile[]): void {
	for (const { descriptor } of files) closeSync(descriptor);
}
