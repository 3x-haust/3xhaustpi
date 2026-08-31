import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fileParallelism: process.platform !== "win32",
		include: ["test/*.test.ts"],
	},
});
