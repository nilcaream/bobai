const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

function pad2(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/**
 * Format the current (or given) date for inclusion in a system prompt.
 *
 * Output format: `"2025-07-14 Mon 14:32 UTC+2"`
 *
 * - ISO date: YYYY-MM-DD
 * - Day of week abbreviation: Mon, Tue, …
 * - Time: HH:MM (24-hour, local)
 * - Timezone: UTC+N / UTC-N (with minutes like UTC+5:30 for non-hour offsets)
 */
export function formatPromptDate(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = pad2(now.getMonth() + 1);
	const day = pad2(now.getDate());
	const dayName = DAYS[now.getDay()];
	const hours = pad2(now.getHours());
	const minutes = pad2(now.getMinutes());

	// getTimezoneOffset() returns minutes west of UTC → negate for conventional sign
	const offsetTotal = -now.getTimezoneOffset();
	const sign = offsetTotal >= 0 ? "+" : "-";
	const absOffset = Math.abs(offsetTotal);
	const offsetHours = Math.floor(absOffset / 60);
	const offsetMins = absOffset % 60;
	const tz = offsetMins === 0 ? `UTC${sign}${offsetHours}` : `UTC${sign}${offsetHours}:${pad2(offsetMins)}`;

	return `${year}-${month}-${day} ${dayName} ${hours}:${minutes} ${tz}`;
}
