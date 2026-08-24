import { CliArgumentError, parseCliArgs } from "./args.ts";
import { executeCliCommand } from "./cli-dispatch.ts";
import { formatCliError } from "./cli-error.ts";
import { PRODUCT_DISPLAY_NAME } from "./product-identity.ts";

try {
	await executeCliCommand(parseCliArgs(process.argv.slice(2)));
} catch (error) {
	const message = error instanceof Error ? error.message : String(error);
	const prefix = error instanceof CliArgumentError ? "Usage error" : PRODUCT_DISPLAY_NAME;
	console.error(formatCliError(prefix, message, process.env.NO_COLOR === undefined && process.env.TERM !== "dumb"));
	process.exitCode = 2;
}
