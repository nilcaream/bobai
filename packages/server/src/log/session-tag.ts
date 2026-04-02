export function sessionScope(sessionId: string): string {
	const dash = sessionId.indexOf("-");
	return dash > 0 ? sessionId.slice(0, dash) : sessionId;
}

export function subagentScope(parentSessionId: string, childSessionId: string): string {
	return `${sessionScope(parentSessionId)}-${sessionScope(childSessionId)}`;
}
