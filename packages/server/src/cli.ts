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
	verify: boolean;
}

export type CLICommand = ServeCommand | AuthCommand | RefreshCommand;

export function parseCLI(argv: string[]): CLICommand {
	const debug = argv.includes("--debug");
	const verify = argv.includes("--verify");

	if (argv[0] === "auth") {
		const provider = argv.find((arg, index) => index > 0 && !arg.startsWith("--"));
		return { command: "auth", debug, provider };
	}

	if (argv[0] === "refresh") {
		return { command: "refresh", debug, verify };
	}

	return { command: "serve", debug };
}
