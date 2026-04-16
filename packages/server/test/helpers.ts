import { Database } from "bun:sqlite";
import type { ServerMessage } from "../src/protocol";
import { createServer, type ServerOptions } from "../src/server";

export function createTestDb(): Database {
	const db = new Database(":memory:");
	db.exec("PRAGMA foreign_keys = ON");
	db.exec(`
		CREATE TABLE sessions (
			id TEXT PRIMARY KEY,
			title TEXT,
			model TEXT,
			parent_id TEXT REFERENCES sessions(id),
			prompt_tokens INTEGER NOT NULL DEFAULT 0,
			prompt_chars INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE messages (
			id TEXT PRIMARY KEY,
			session_id TEXT NOT NULL REFERENCES sessions(id),
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			created_at TEXT NOT NULL,
			sort_order INTEGER NOT NULL,
			metadata TEXT
		)
	`);
	db.exec("CREATE INDEX idx_messages_session ON messages(session_id, sort_order)");
	return db;
}

export function startTestServer(options: ServerOptions): {
	server: ReturnType<typeof Bun.serve>;
	baseUrl: string;
	wsUrl: string;
} {
	const server = createServer(options);
	return {
		server,
		baseUrl: `http://localhost:${server.port}`,
		wsUrl: `ws://localhost:${server.port}/bobai/ws`,
	};
}

export function openWs(wsUrl: string): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		ws.onopen = () => resolve(ws);
		ws.onerror = (event) => reject(event);
	});
}

export function waitForWsMessage<T extends ServerMessage = ServerMessage>(
	ws: WebSocket,
	predicate: (message: ServerMessage) => message is T,
	timeoutMs = 2000,
): Promise<T>;
export function waitForWsMessage(
	ws: WebSocket,
	predicate: (message: ServerMessage) => boolean,
	timeoutMs?: number,
): Promise<ServerMessage>;
export function waitForWsMessage(
	ws: WebSocket,
	predicate: (message: ServerMessage) => boolean,
	timeoutMs = 2000,
): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			ws.removeEventListener("message", handler);
			reject(new Error("Timed out waiting for message"));
		}, timeoutMs);
		const handler = (event: MessageEvent) => {
			const parsed = JSON.parse(event.data as string) as ServerMessage;
			if (!predicate(parsed)) return;
			clearTimeout(timer);
			ws.removeEventListener("message", handler);
			resolve(parsed);
		};
		ws.addEventListener("message", handler);
	});
}

export function collectWsMessages(ws: WebSocket): {
	messages: ServerMessage[];
	stop: () => void;
} {
	const messages: ServerMessage[] = [];
	const handler = (event: MessageEvent) => {
		messages.push(JSON.parse(event.data as string) as ServerMessage);
	};
	ws.addEventListener("message", handler);
	return {
		messages,
		stop: () => ws.removeEventListener("message", handler),
	};
}
