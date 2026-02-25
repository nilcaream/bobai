import os from "node:os";
import path from "node:path";
import { authorize } from "./auth/authorize";
import { loadToken } from "./auth/store";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { installFetchInterceptor } from "./log/fetch";
import { createLogger } from "./log/logger";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createCopilotProvider } from "./provider/copilot";
import { createServer } from "./server";

const debug = process.argv.includes("--debug");
const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
const logDir = path.join(dataHome, "bobai", "log");
const logger = createLogger({ level: debug ? "debug" : "info", logDir });
installFetchInterceptor({ logger, logDir, debug });

logger.info("SERVER", `Starting bobai (debug=${debug})`);

const projectRoot = process.cwd();
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");
const globalConfigDir = path.join(os.homedir(), ".config", "bobai");

const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(projectRoot);
const config = resolveConfig({ provider: project.provider, model: project.model }, globalConfig.preferences);

let token = loadToken(globalConfigDir, config.provider);
if (!token) {
	token = await authorize(globalConfigDir, config.provider);
}

const provider = createCopilotProvider(token);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const server = createServer({ port, staticDir, provider, model: config.model });

logger.info("SERVER", `Project: ${project.id}`);
logger.info("SERVER", `Provider: ${config.provider} / ${config.model}`);
logger.info("SERVER", `Listening at http://localhost:${server.port}/bobai`);

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
