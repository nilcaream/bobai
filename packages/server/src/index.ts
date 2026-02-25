import os from "node:os";
import path from "node:path";
import { authorize } from "./auth/authorize";
import { loadToken } from "./auth/store";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createCopilotProvider } from "./provider/copilot";
import { createServer } from "./server";

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

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
