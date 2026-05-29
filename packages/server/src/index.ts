import fs from "node:fs";
import path from "node:path";
import { authorizeCopilot, getAuthProvider, listSupportedAuthProviders } from "./auth/authorize";
import { loadAuthStore } from "./auth/store";
import { parseCLI } from "./cli";
import { resolveValidatedDefaultBackend } from "./config/default-backend";
import { loadGlobalConfig } from "./config/global";
import { resolveConfig } from "./config/resolve";
import { createTrackingFetch } from "./log/fetch";
import { createLogger } from "./log/logger";
import { createPlatform, detectAvailableTools } from "./platform";
import { loadPlugins } from "./plugins/loader";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { ensureModelCatalogAvailable } from "./provider/model-catalog-startup";
import { providerModelsConfigExists } from "./provider/models";
import { isSupportedAuthProvider, isSupportedProvider } from "./provider/providers";
import { createProviderRuntimeManager } from "./provider/runtime-manager";
import { refreshUnifiedModelCatalog, unifiedModelsConfigExists } from "./provider/unified-model-catalog";
import { createServer } from "./server";
import { builtinSkills } from "./skill/builtin";
import { discoverSkills } from "./skill/skill";

const cli = parseCLI(process.argv.slice(2));
const platform = createPlatform();
const globalConfigDir = platform.paths.configDir;
const logDir = platform.paths.logDir;

if (cli.command === "auth") {
	const logger = createLogger({ level: cli.debug ? "debug" : "info", logDir });

	if (!cli.provider) {
		for (const provider of listSupportedAuthProviders()) {
			console.log(provider.id);
		}
		process.exit(1);
	}

	if (!isSupportedAuthProvider(cli.provider)) {
		console.error(`Unsupported provider: ${cli.provider}`);
		process.exit(1);
	}

	logger.info("AUTH", `Starting authentication flow for ${cli.provider}`);
	if (cli.provider === "github-copilot") {
		await authorizeCopilot(globalConfigDir);
		process.exit(0);
	}

	const authProvider = getAuthProvider(cli.provider);
	if (!authProvider) {
		console.error(`Unsupported provider: ${cli.provider}`);
		process.exit(1);
	}
	try {
		await authProvider.authorize(globalConfigDir);
		process.exit(0);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(message);
		process.exit(1);
	}
}

if (cli.command === "refresh") {
	try {
		const authStore = loadAuthStore(globalConfigDir);
		const bedrockAuth = authStore?.providers["amazon-bedrock"];
		const result = await refreshUnifiedModelCatalog(globalConfigDir, { bedrockAuth });
		console.log(`Wrote ${result.modelCount} models to ${result.configPath}`);
		if (bedrockAuth) {
			console.log(`Amazon Bedrock: refreshed from live API (${bedrockAuth.region})`);
		}
		if (!result.multiplierSourceAvailable) {
			console.log("Copilot multiplier metadata unavailable; Copilot models were written with ?x fallback.");
		}
		process.exit(0);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Model refresh failed: ${message}`);
		process.exit(1);
	}
}

// Serve command: load config before creating logger so debug preference is respected
const globalConfig = loadGlobalConfig(globalConfigDir);
const project = await initProject(process.cwd());

// Merge debug: CLI flag OR global config OR project config
const debug = cli.debug || globalConfig.preferences.debug === true || project.debug === true;
const logger = createLogger({ level: debug ? "debug" : "info", logDir });
const trackingFetch = createTrackingFetch(fetch, { logger, logDir, debug });

logger.info("SERVER", `Starting bobai (debug=${debug})`);
const bobaiVersion = process.env.BOBAI_VERSION ?? "dev";
logger.info("SERVER", `Version: ${bobaiVersion}`);

await ensureModelCatalogAvailable({
	catalogExists: () => unifiedModelsConfigExists(globalConfigDir),
	refreshCatalog: async () => {
		const result = await refreshUnifiedModelCatalog(globalConfigDir);
		logger.info("MODEL", `Wrote ${result.modelCount} models to ${result.configPath}`);
		if (!result.multiplierSourceAvailable) {
			logger.error("MODEL", "Copilot multiplier metadata unavailable; Copilot models were written with ?x fallback.");
		}
	},
	logger,
});

const config = resolveConfig(
	{ provider: project.provider, model: project.model, maxIterations: project.maxIterations },
	globalConfig.preferences,
);
const defaultBackend = resolveValidatedDefaultBackend(
	{
		project: { filePath: project.configFilePath, provider: project.provider, model: project.model },
		global: {
			filePath: globalConfig.filePath,
			provider: globalConfig.preferences.provider,
			model: globalConfig.preferences.model,
		},
		configDir: globalConfigDir,
	},
	logger,
);

const skillDirectories = [platform.skillsDir, path.join(process.cwd(), ".bobai", "skills")];
const skills = discoverSkills(skillDirectories, { debug, builtinSkills });
logger.info("SKILL", `Discovered ${skills.list().length} skill(s)`);
for (const skill of skills.list()) {
	logger.info("SKILL", `${skill.name}: ${skill.filePath}`);
}

if (defaultBackend?.provider && !isSupportedProvider(defaultBackend.provider)) {
	console.error(`Unsupported provider: ${defaultBackend.provider}`);
	process.exit(1);
}

if (defaultBackend?.provider && !providerModelsConfigExists(defaultBackend.provider, globalConfigDir)) {
	console.error("Model configuration not found. Please run: bobai refresh");
	process.exit(1);
}

const runtimeManager = createProviderRuntimeManager({
	configDir: globalConfigDir,
	logger,
	fetch: trackingFetch,
});
const port = resolvePort(process.argv.slice(2), { port: project.port }, { port: globalConfig.preferences.port });

// Detect platform-available tools (shell, grep, git).
const availableTools = await detectAvailableTools(platform.info);
logger.info(
	"PLATFORM",
	`${platform.info.id}: shells=[${availableTools.shells.join(",")}] grep=[${availableTools.grepTools.join(",")}] git=${availableTools.git}`,
);

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
	runtimeManager,
	providerId: defaultBackend?.provider,
	model: defaultBackend?.model ?? undefined,
	defaultStatus: defaultBackend ? undefined : "select provider and model",
	maxIterations: config.maxIterations,
	projectRoot: process.cwd(),
	configDir: globalConfigDir,
	projectConfig: {
		debug: project.debug,
		port: project.port,
		provider: project.provider,
		model: project.model,
		maxIterations: project.maxIterations,
	},
	globalConfig: globalConfig.preferences,
	skills,
	skillDirectories,
	logger,
	logDir,
	debug,
	startedAt: Date.now(),
	availableTools,
	platformInfo: platform.info,
});

logger.info("SERVER", `Project: ${project.id}`);
logger.info("SERVER", `Provider: ${defaultBackend ? `${defaultBackend.provider} / ${defaultBackend.model}` : "(none)"}`);
logger.info("SERVER", `Listening at http://localhost:${server.port}/bobai`);

console.log(`Project: ${project.id}`);
console.log(`Provider: ${defaultBackend ? `${defaultBackend.provider} / ${defaultBackend.model}` : "(none)"}`);
console.log(`http://localhost:${server.port}/bobai`);

await loadPlugins(platform.pluginsDir, logger);
