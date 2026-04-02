import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLogger } from "../src/log/logger";
import { loadPlugins } from "../src/plugins/loader";

describe("loadPlugins", () => {
	let tmpDir: string;
	let logDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bobai-plugins-"));
		logDir = path.join(tmpDir, "log");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	function readLog(): string {
		if (!fs.existsSync(logDir)) return "";
		const files = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));
		const [firstFile] = files;
		if (firstFile === undefined) return "";
		return fs.readFileSync(path.join(logDir, firstFile), "utf8");
	}

	test("skips silently when plugins directory does not exist", async () => {
		const configDir = path.join(tmpDir, "nonexistent-config");
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(configDir, logger);

		expect(readLog()).not.toContain("PLUGIN");
	});

	test("skips silently when plugins directory is empty", async () => {
		fs.mkdirSync(path.join(tmpDir, "plugins"));
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(tmpDir, logger);

		expect(readLog()).not.toContain("PLUGIN");
	});

	test("ignores files that are not .ts or .js", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		fs.writeFileSync(path.join(pluginsDir, "config.json"), "{}");
		fs.writeFileSync(path.join(pluginsDir, "readme.md"), "# readme");
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(tmpDir, logger);

		expect(readLog()).not.toContain("PLUGIN");
	});

	test("ignores subdirectories inside plugins dir", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		fs.mkdirSync(path.join(pluginsDir, "subdir"));
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(tmpDir, logger);

		expect(readLog()).not.toContain("PLUGIN");
	});

	test("loads a .js plugin and logs its full path at INFO level", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		const pluginPath = path.join(pluginsDir, "my-plugin.js");
		fs.writeFileSync(pluginPath, "// no-op plugin");
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(tmpDir, logger);

		expect(readLog()).toContain(`INFO PLUGIN global Loaded plugin ${pluginPath}`);
	});

	test("loads a .ts plugin and logs its full path at INFO level", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		const pluginPath = path.join(pluginsDir, "my-plugin.ts");
		fs.writeFileSync(pluginPath, "// no-op ts plugin");
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(tmpDir, logger);

		expect(readLog()).toContain(`INFO PLUGIN global Loaded plugin ${pluginPath}`);
	});

	test("loads plugins in alphabetical filename order", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		// Write out-of-order to make sure sorting is applied
		const pathC = path.join(pluginsDir, "c-plugin.js");
		const pathA = path.join(pluginsDir, "a-plugin.js");
		const pathB = path.join(pluginsDir, "b-plugin.js");
		fs.writeFileSync(pathC, "// c");
		fs.writeFileSync(pathA, "// a");
		fs.writeFileSync(pathB, "// b");
		const logger = createLogger({ level: "info", logDir });

		await loadPlugins(tmpDir, logger);

		const log = readLog();
		const lines = log.trim().split("\n");
		expect(lines[0]).toContain("a-plugin.js");
		expect(lines[1]).toContain("b-plugin.js");
		expect(lines[2]).toContain("c-plugin.js");
	});

	test("exits with code 1 and prints plugin path and error when plugin throws", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		const badPlugin = path.join(pluginsDir, "bad.js");
		fs.writeFileSync(badPlugin, 'throw new Error("plugin exploded");');
		const logger = createLogger({ level: "info", logDir });

		let capturedExitCode: number | undefined;
		const origExit = process.exit.bind(process);
		process.exit = ((code?: number) => {
			capturedExitCode = code;
			throw new Error("_exit_sentinel");
		}) as typeof process.exit;

		const logged: string[] = [];
		const origLog = console.log;
		console.log = (...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		};

		try {
			await loadPlugins(tmpDir, logger);
		} catch (err) {
			if (!(err instanceof Error) || err.message !== "_exit_sentinel") throw err;
		} finally {
			process.exit = origExit;
			console.log = origLog;
		}

		expect(capturedExitCode).toBe(1);
		const output = logged.join("\n");
		expect(output).toContain(badPlugin);
		expect(output).toContain("plugin exploded");
	});

	test("does not load subsequent plugins after one fails", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);
		fs.writeFileSync(path.join(pluginsDir, "a-bad.js"), 'throw new Error("first fails");');
		fs.writeFileSync(path.join(pluginsDir, "b-good.js"), "// should not be reached");
		const logger = createLogger({ level: "info", logDir });

		const exitSpy = spyOn(process, "exit").mockImplementation(() => {
			throw new Error("process.exit called");
		});

		try {
			await loadPlugins(tmpDir, logger);
		} catch {
			// expected: exit was called
		} finally {
			exitSpy.mockRestore();
		}

		expect(readLog()).not.toContain("b-good.js");
	});

	test("loads a symlinked .js plugin", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);

		// Create the real plugin file outside the plugins directory
		const externalPlugin = path.join(tmpDir, "external", "my-plugin.js");
		fs.mkdirSync(path.dirname(externalPlugin), { recursive: true });
		fs.writeFileSync(externalPlugin, "// symlinked no-op plugin");

		// Symlink it into the plugins directory
		fs.symlinkSync(externalPlugin, path.join(pluginsDir, "my-plugin.js"));

		const logger = createLogger({ level: "info", logDir });
		await loadPlugins(tmpDir, logger);

		expect(readLog()).toContain("PLUGIN");
		expect(readLog()).toContain("my-plugin.js");
	});

	test("ignores a symlink that does not end in .ts or .js", async () => {
		const pluginsDir = path.join(tmpDir, "plugins");
		fs.mkdirSync(pluginsDir);

		const externalFile = path.join(tmpDir, "external", "notes.md");
		fs.mkdirSync(path.dirname(externalFile), { recursive: true });
		fs.writeFileSync(externalFile, "# not a plugin");

		fs.symlinkSync(externalFile, path.join(pluginsDir, "notes.md"));

		const logger = createLogger({ level: "info", logDir });
		await loadPlugins(tmpDir, logger);

		expect(readLog()).not.toContain("PLUGIN");
	});
});
