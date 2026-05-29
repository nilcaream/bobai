const FIELDS = ["debug", "port", "provider", "model", "maxIterations"] as const;

const SKIP_FIELDS = new Set<string>(["id"]);

export function formatConfig(config: Record<string, unknown>, _scope: string): string {
	const lines: string[] = [];

	for (const field of FIELDS) {
		if (SKIP_FIELDS.has(field)) continue;
		const value = config[field];
		const display = value !== undefined ? String(value) : "(not set)";
		lines.push(`${field} = ${display}`);
	}

	return lines.join("\n");
}
