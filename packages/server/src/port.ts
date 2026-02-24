export interface PortConfig {
	port?: number;
}

export function resolvePort(argv: string[], config: PortConfig): number {
	const cliPort = parseCLIPort(argv);
	if (cliPort !== undefined) return cliPort;
	if (config.port !== undefined) return config.port;
	return 0;
}

function parseCLIPort(argv: string[]): number | undefined {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--port") {
			const raw = argv[i + 1];
			return parsePort(raw ?? "");
		}
		if (arg?.startsWith("--port=")) {
			return parsePort(arg.slice("--port=".length));
		}
	}
	return undefined;
}

function parsePort(raw: string): number {
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > 65535) {
		throw new Error(`Invalid port: "${raw}". Must be an integer between 1 and 65535.`);
	}
	return n;
}
