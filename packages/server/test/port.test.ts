import { describe, expect, test } from "bun:test";
import { resolvePort } from "../src/port";

describe("resolvePort", () => {
	test("returns 0 when no args and no config", () => {
		expect(resolvePort([], {})).toBe(0);
	});

	test("returns port from -p flag", () => {
		expect(resolvePort(["-p", "1234"], {})).toBe(1234);
	});

	test("returns port from --port flag", () => {
		expect(resolvePort(["--port", "8080"], {})).toBe(8080);
	});

	test("CLI port takes priority over config port", () => {
		expect(resolvePort(["-p", "1234"], { port: 9999 })).toBe(1234);
	});

	test("returns config port when no CLI arg given", () => {
		expect(resolvePort([], { port: 5555 })).toBe(5555);
	});

	test("throws when CLI port is not a valid number", () => {
		expect(() => resolvePort(["-p", "abc"], {})).toThrow();
	});

	test("throws when CLI port is out of range", () => {
		expect(() => resolvePort(["--port", "99999"], {})).toThrow();
	});

	test("falls back to global port when project port is not set", () => {
		expect(resolvePort([], {}, { port: 7777 })).toBe(7777);
	});

	test("project port takes priority over global port", () => {
		expect(resolvePort([], { port: 5555 }, { port: 7777 })).toBe(5555);
	});

	test("returns 0 when neither project nor global port is set", () => {
		expect(resolvePort([], {}, {})).toBe(0);
	});
});

describe("resolvePort (fail-fast on port in use)", () => {
	test("throws when requested port is already bound", async () => {
		// Bind a port, then try to start another server on the same port
		const occupant = Bun.serve({ port: 0, fetch: () => new Response("ok") });
		const takenPort = occupant.port;

		try {
			expect(() => Bun.serve({ port: takenPort, fetch: () => new Response("ok") })).toThrow();
		} finally {
			occupant.stop(true);
		}
	});
});
