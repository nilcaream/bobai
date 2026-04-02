import fs from "node:fs";
import path from "node:path";
import { getScope, localTimestamp } from "./logger";

export interface DumpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string;
}

export interface DumpResponse {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	latencyMs: number;
}

function dumpFilename(): string {
	const ts = localTimestamp().replace(/[-: .]/g, "");
	const date = ts.slice(0, 8);
	const time = ts.slice(8);
	const scope = getScope() ?? "global";
	return `debug-${date}-${time}-${scope}-http.txt`;
}

export function maskAuthHeader(headers: Record<string, string>): Record<string, string> {
	const masked = { ...headers };
	const key = Object.keys(masked).find((k) => k.toLowerCase() === "authorization");
	if (!key) return masked;
	const value = masked[key];
	if (!value.startsWith("Bearer ")) return masked;
	const token = value.slice("Bearer ".length);

	// Session tokens (tid=...;exp=...;proxy-ep=...) contain mostly metadata.
	// Mask the tid value (the actual secret) but keep exp and proxy-ep visible
	// for diagnostics.
	if (token.includes(";") && token.includes("tid=")) {
		const maskedToken = token.replace(/tid=([^;]+)/, (_, tid: string) => {
			return `tid=${tid.length > 8 ? `${tid.slice(0, 3)}***${tid.slice(-3)}` : "***"}`;
		});
		masked[key] = `Bearer ${maskedToken}`;
		return masked;
	}

	// OAuth tokens (gho_xxx) — show prefix + last 4
	if (token.startsWith("gho_")) {
		masked[key] = `Bearer gho_***${token.slice(-4)}`;
		return masked;
	}

	// Fallback: generic masking
	masked[key] = `Bearer ${token.length > 8 ? `${token.slice(0, 4)}***${token.slice(-4)}` : "***"}`;
	return masked;
}

function formatHeaders(headers: Record<string, string>): string {
	return Object.entries(headers)
		.map(([k, v]) => `${k}: ${v}`)
		.join("\n");
}

export function writeDump(logDir: string, request: DumpRequest, response: DumpResponse): string {
	const filename = dumpFilename();
	const filePath = path.join(logDir, filename);

	const sections: string[] = [];

	sections.push(`>>> ${request.method} ${request.url}`);
	const reqHeaders = formatHeaders(request.headers);
	if (reqHeaders) sections.push(reqHeaders);
	sections.push("");
	if (request.body) sections.push(request.body);
	sections.push("");

	sections.push(`<<< ${response.status} ${response.statusText} (${response.latencyMs}ms)`);
	const respHeaders = formatHeaders(response.headers);
	if (respHeaders) sections.push(respHeaders);
	sections.push("");
	if (response.body) sections.push(response.body);

	try {
		fs.writeFileSync(filePath, sections.join("\n"));
	} catch {
		process.stderr.write(`[dump] Failed to write ${filePath}\n`);
		return "";
	}
	return filename;
}
