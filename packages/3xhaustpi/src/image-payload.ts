import type { TuiRequestImage } from "./tui-operation-types.ts";

export const MAX_TUI_IMAGES = 8;
export const MAX_TUI_IMAGE_BASE64_BYTES = 5 * 1024 * 1024;

function hasSignature(image: TuiRequestImage, bytes: Buffer): boolean {
	if (image.mimeType === "image/png") {
		return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	}
	if (image.mimeType === "image/jpeg") {
		return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	}
	return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function parseImage(candidate: unknown): TuiRequestImage {
	if (typeof candidate !== "object" || candidate === null) throw new Error("TUI request image is invalid");
	const data = Reflect.get(candidate, "data");
	const mimeType = Reflect.get(candidate, "mimeType");
	if (typeof data !== "string" || !data) throw new Error("TUI request image data is required");
	if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
		throw new Error("TUI request image MIME type is invalid");
	}
	if (Buffer.byteLength(data, "utf8") > MAX_TUI_IMAGE_BASE64_BYTES) {
		throw new Error("TUI request image exceeds the encoded size limit");
	}
	if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)) {
		throw new Error("TUI request image data is not canonical base64");
	}
	const bytes = Buffer.from(data, "base64");
	if (bytes.length === 0 || bytes.toString("base64") !== data) {
		throw new Error("TUI request image data is not canonical base64");
	}
	const image: TuiRequestImage = { data, mimeType };
	if (!hasSignature(image, bytes)) throw new Error(`TUI request ${mimeType} signature is invalid`);
	return image;
}

export function parseImagePayloads(value: unknown): readonly TuiRequestImage[] {
	if (!Array.isArray(value)) throw new Error("TUI request images must be an array");
	if (value.length > MAX_TUI_IMAGES) throw new Error(`TUI requests support at most ${MAX_TUI_IMAGES} images`);
	return value.map(parseImage);
}

export function isImagePayloads(value: unknown): value is readonly TuiRequestImage[] {
	try {
		parseImagePayloads(value);
		return true;
	} catch {
		return false;
	}
}
