export interface ServeCommand {
	command: "serve";
	debug: boolean;
}

export interface AuthCommand {
	command: "auth";
	debug: boolean;
}

export interface RefreshCommand {
	command: "refresh";
	debug: boolean;
}

export type CLICommand = ServeCommand | AuthCommand | RefreshCommand;

export function parseCLI(argv: string[]): CLICommand {
	const debug = argv.includes("--debug");

	if (argv[0] === "auth") {
		return { command: "auth", debug };
	}

	if (argv[0] === "refresh") {
		return { command: "refresh", debug };
	}

	return { command: "serve", debug };
}
