import { DEFAULT_CLIENT_ID } from "./auth/device-flow";

export interface ServeCommand {
	command: "serve";
	debug: boolean;
}

export interface AuthCommand {
	command: "auth";
	debug: boolean;
	clientId: string;
}

export type CLICommand = ServeCommand | AuthCommand;

export function parseCLI(argv: string[]): CLICommand {
	const debug = argv.includes("--debug");

	if (argv[0] === "auth") {
		return {
			command: "auth",
			debug,
			clientId: parseClientId(argv) ?? DEFAULT_CLIENT_ID,
		};
	}

	return { command: "serve", debug };
}

function parseClientId(argv: string[]): string | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--client-id") {
			return argv[i + 1];
		}
		if (arg?.startsWith("--client-id=")) {
			return arg.slice("--client-id=".length);
		}
	}
	return undefined;
}
