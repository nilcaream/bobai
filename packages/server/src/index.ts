import os from "node:os";
import path from "node:path";
import { authorize } from "./auth/authorize";
import { loadAuth, saveAuth } from "./auth/store";
import { parseCLI } from "./cli";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { installFetchInterceptor } from "./log/fetch";
import { createLogger } from "./log/logger";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createCopilotProvider, deriveBaseUrl, exchangeToken, refreshModels } from "./provider/copilot";
import { createServer } from "./server";

const cli = parseCLI(process.argv.slice(2));

const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const logDir = path.join(dataHome, "bobai", "log");
const logger = createLogger({ level: cli.debug ? "debug" : "info", logDir });
installFetchInterceptor({ logger, logDir, debug: cli.debug });

const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

if (cli.command === "auth") {
	logger.info("AUTH", "Starting authentication flow");
	const auth = await authorize(globalConfigDir);
	await refreshModels(auth.access, deriveBaseUrl(auth.access), globalConfigDir);
	process.exit(0);
}

if (cli.command === "refresh") {
	let auth = loadAuth(globalConfigDir);
	if (!auth) {
		console.error("No auth found. Run `bobai auth` first.");
		process.exit(1);
	}
	if (Date.now() >= auth.expires) {
		const session = await exchangeToken(auth.refresh);
		auth = { refresh: auth.refresh, access: session.access, expires: session.expires };
		saveAuth(globalConfigDir, auth);
	}
	await refreshModels(auth.access, deriveBaseUrl(auth.access), globalConfigDir);
	process.exit(0);
}

logger.info("SERVER", `Starting bobai (debug=${cli.debug})`);

const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(process.cwd());
const config = resolveConfig({ provider: project.provider, model: project.model }, globalConfig.preferences);

let auth = loadAuth(globalConfigDir);
if (!auth) {
	auth = await authorize(globalConfigDir);
}

const provider = createCopilotProvider(auth, globalConfigDir);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");
const server = createServer({ port, staticDir, db: project.db, provider, model: config.model, projectRoot: process.cwd() });

logger.info("SERVER", `Project: ${project.id}`);
logger.info("SERVER", `Provider: ${config.provider} / ${config.model}`);
logger.info("SERVER", `Listening at http://localhost:${server.port}/bobai`);

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
