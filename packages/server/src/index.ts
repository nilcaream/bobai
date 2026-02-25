import os from "node:os";
import path from "node:path";
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

const token = globalConfig.auth[config.provider]?.token;
if (!token) {
	console.error(`No auth token found for provider "${config.provider}".`);
	console.error(`\nSet up authentication:`);
	console.error(`  mkdir -p ~/.config/bobai`);
	console.error(`  echo '{"${config.provider}": {"token": "YOUR_TOKEN"}}' > ~/.config/bobai/auth.json`);
	process.exit(1);
}

const provider = createCopilotProvider(token);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const server = createServer({ port, staticDir, provider, model: config.model });

console.log(`Project: ${project.id}`);
console.log(`Provider: ${config.provider} / ${config.model}`);
console.log(`http://localhost:${server.port}/bobai`);
