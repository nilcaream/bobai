export function parseSessionUrl(pathname: string): { sessionId: string | null } {
	const clean = pathname.replace(/\?.*$/, "").replace(/\/+$/, "");
	const match = clean.match(/^\/bobai\/([^/]+)$/);
	if (match?.[1]) {
		return { sessionId: decodeURIComponent(match[1]) };
	}
	return { sessionId: null };
}

export function buildSessionUrl(sessionId: string | null): string {
	if (sessionId) return `/bobai/${encodeURIComponent(sessionId)}`;
	return "/bobai";
}
