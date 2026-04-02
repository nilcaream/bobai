export function sessionTag(sessionId: string): string {
	const dash = sessionId.indexOf("-");
	return dash > 0 ? sessionId.slice(0, dash) : sessionId;
}

export function subagentTag(parentSessionId: string, childSessionId: string): string {
	return `${sessionTag(parentSessionId)}:${sessionTag(childSessionId)}`;
}
