export interface ServeCommand {
	command: "serve";
	debug: boolean;
}

export interface AuthCommand {
	command: "auth";
	debug: boolean;
	provider?: string;
}

export interface RefreshCommand {
	command: "refresh";
	debug: boolean;
}

export type CLICommand = ServeCommand | AuthCommand | RefreshCommand;

export function parseCLI(argv: string[]): CLICommand {
	const debug = argv.includes("--debug");

	if (argv[0] === "auth") {
		const provider = argv.find((arg, index) => index > 0 && !arg.startsWith("--"));
		return { command: "auth", debug, provider };
	}

	if (argv[0] === "refresh") {
		if (argv.includes("--verify")) {
			throw new Error("--verify has been removed; refresh no longer verifies model availability");
		}
		return { command: "refresh", debug };
	}

	return { command: "serve", debug };
}
