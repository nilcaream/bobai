import { PlatformResolver, parsePlatformId } from "./resolver";

export { detectAvailableTools } from "./detection";
export { PlatformResolver } from "./resolver";
export type { AvailableTools, PlatformId, PlatformInfo, PlatformPaths } from "./types";

/**
 * Create the platform resolver from the BOBAI_PLATFORM environment variable.
 * Throws if the variable is missing or contains an unknown identifier.
 */
export function createPlatform(): PlatformResolver {
	const raw = process.env.BOBAI_PLATFORM;
	if (!raw) {
		throw new Error(
			"BOBAI_PLATFORM is not set. The runner script must set this environment variable.\n" +
				"Reinstall Bob AI using the correct installer for your platform.",
		);
	}
	const info = parsePlatformId(raw);
	return new PlatformResolver(info);
}
