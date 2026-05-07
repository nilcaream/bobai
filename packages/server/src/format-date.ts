const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/**
 * Format the current (or given) date for inclusion in a system prompt.
 *
 * Output format: `"2025-07-14 Mon"`
 *
 * - ISO date: YYYY-MM-DD
 * - Day of week abbreviation: Mon, Tue, …
 *
 * Time and timezone are intentionally omitted to keep the system prompt
 * stable across turns within the same day, preserving LLM prefix-cache hits.
 */
export function formatPromptDate(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = pad2(now.getMonth() + 1);
	const day = pad2(now.getDate());
	const dayName = DAYS[now.getDay()];

	return `${year}-${month}-${day} ${dayName}`;
}
