import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authorize } from "./auth/authorize";
import { loadAuth, saveAuth } from "./auth/store";
import { parseCLI } from "./cli";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { installFetchInterceptor } from "./log/fetch";
import { createLogger } from "./log/logger";
import { loadPlugins } from "./plugins/loader";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createCopilotProvider, deriveBaseUrl, exchangeToken, refreshModels } from "./provider/copilot";
import { modelsConfigExists } from "./provider/copilot-models";
import { createServer } from "./server";
import { builtinSkills } from "./skill/builtin";
import { discoverSkills } from "./skill/skill";

const cli = parseCLI(process.argv.slice(2));

const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const logDir = path.join(dataHome, "bobai", "log");
const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

if (cli.command === "auth") {
	const logger = createLogger({ level: cli.debug ? "debug" : "info", logDir });
	installFetchInterceptor({ logger, logDir, debug: cli.debug });
	logger.info("AUTH", "Starting authentication flow");
	const auth = await authorize(globalConfigDir);
	await refreshModels(auth.access, deriveBaseUrl(auth.access), globalConfigDir, { verify: true });
	process.exit(0);
}

if (cli.command === "refresh") {
	const logger = createLogger({ level: cli.debug ? "debug" : "info", logDir });
	installFetchInterceptor({ logger, logDir, debug: cli.debug });

	if (!cli.verify) {
		await refreshModels("", "", globalConfigDir, { verify: false });
		process.exit(0);
	}

	let auth = loadAuth(globalConfigDir);
	if (!auth) {
		console.error("No auth found. Run `bobai auth` first.");
		process.exit(1);
	}
	if (Date.now() >= auth.expires) {
		try {
			const session = await exchangeToken(auth.refresh);
			auth = { refresh: auth.refresh, access: session.access, expires: session.expires };
			saveAuth(globalConfigDir, auth);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`Token refresh failed: ${message}`);
			console.error("Your session may have expired. Run `bobai auth` to re-authenticate.");
			process.exit(1);
		}
	}
	await refreshModels(auth.access, deriveBaseUrl(auth.access), globalConfigDir, { verify: true });
	process.exit(0);
}

// Serve command: load config before creating logger so debug preference is respected
const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(process.cwd());

// Merge debug: CLI flag OR global config OR project config
const debug = cli.debug || globalConfig.preferences.debug === true || project.debug === true;
const logger = createLogger({ level: debug ? "debug" : "info", logDir });
installFetchInterceptor({ logger, logDir, debug });

logger.info("SERVER", `Starting bobai (debug=${debug})`);

const config = resolveConfig(
	{ provider: project.provider, model: project.model, maxIterations: project.maxIterations },
	globalConfig.preferences,
);

const skillDirectories = [path.join(globalConfigDir, "skills"), path.join(process.cwd(), ".bobai", "skills")];
const skills = discoverSkills(skillDirectories, { debug, builtinSkills });
logger.info("SKILL", `Discovered ${skills.list().length} skill(s)`);
for (const skill of skills.list()) {
	logger.info("SKILL", `${skill.name}: ${skill.filePath}`);
}

if (!modelsConfigExists(globalConfigDir)) {
	console.error("Model configuration not found. Please run: bobai refresh");
	process.exit(1);
}

let auth = loadAuth(globalConfigDir);
if (!auth) {
	auth = await authorize(globalConfigDir);
}

const provider = createCopilotProvider(auth, globalConfigDir, logger);
const port = resolvePort(process.argv.slice(2), { port: project.port });
// Bundled layout: server.js + ui/ live side-by-side in dist/.
// Source layout:  packages/server/src/index.ts → ../../ui/dist.
const bundledUi = path.resolve(import.meta.dir, "ui");
const staticDir = fs.existsSync(path.join(bundledUi, "index.html"))
	? bundledUi
	: path.resolve(import.meta.dir, "../../ui/dist");
const server = createServer({
	port,
	staticDir,
	db: project.db,
	dbGuard: project.dbGuard,
	provider,
	model: config.model,
	maxIterations: config.maxIterations,
	projectRoot: process.cwd(),
	configDir: globalConfigDir,
	skills,
	skillDirectories,
	logger,
	logDir,
	debug,
	startedAt: Date.now(),
});

logger.info("SERVER", `Project: ${project.id}`);
logger.info("SERVER", `Provider: ${config.provider} / ${config.model}`);
logger.info("SERVER", `Listening at http://localhost:${server.port}/bobai`);

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);

await loadPlugins(globalConfigDir, logger);
