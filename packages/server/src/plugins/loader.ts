import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../log/logger";

export async function loadPlugins(configDir: string, logger: Logger): Promise<void> {
	const pluginsDir = path.join(configDir, "plugins");

	if (!fs.existsSync(pluginsDir)) {
		return;
	}

	const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
	const pluginPaths = entries
		.filter((e) => e.isFile() && (e.name.endsWith(".ts") || e.name.endsWith(".js")))
		.map((e) => path.join(pluginsDir, e.name))
		.sort();

	for (const pluginPath of pluginPaths) {
		try {
			await import(pluginPath);
			logger.info("PLUGIN", `Loaded plugin ${pluginPath}`);
		} catch (err) {
			const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
			console.log(`Failed to load plugin ${pluginPath}:\n${detail}`);
			process.exit(1);
		}
	}
}
