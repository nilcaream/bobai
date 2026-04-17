export type FuzzyMatchOptions = {
	separatorMatcher?: (char: string) => boolean;
};

const DEFAULT_PICKER_SEPARATOR = (char: string) => /[^a-z0-9]/i.test(char);
const SLASH_SEPARATOR = (char: string) => char === "-";

export const SLASH_FUZZY_OPTIONS: FuzzyMatchOptions = {
	separatorMatcher: SLASH_SEPARATOR,
};

export const PICKER_FUZZY_OPTIONS: FuzzyMatchOptions = {
	separatorMatcher: DEFAULT_PICKER_SEPARATOR,
};

export function fuzzyMatch(query: string, candidate: string, options: FuzzyMatchOptions = PICKER_FUZZY_OPTIONS): number | null {
	if (query.length === 0) return 0;

	const q = query.toLowerCase();
	const c = candidate.toLowerCase();

	if (c.startsWith(q)) return 0;

	let qi = 0;
	let score = 0;
	let prevMatchIdx = -2;
	const wordStarts = new Set<number>([0]);
	const isSeparator = options.separatorMatcher ?? DEFAULT_PICKER_SEPARATOR;

	for (let i = 0; i < c.length - 1; i++) {
		if (isSeparator(c[i] ?? "")) wordStarts.add(i + 1);
	}

	for (let ci = 0; ci < c.length && qi < q.length; ci++) {
		if (c[ci] === q[qi]) {
			const atWordStart = wordStarts.has(ci);
			score += atWordStart ? 0 : 1;
			score += ci === prevMatchIdx + 1 ? 0 : 1;
			prevMatchIdx = ci;
			qi++;
		}
	}

	if (qi < q.length) return null;
	return score;
}

export function fuzzyFilterAndSort<T>(
	items: T[],
	query: string,
	selectText: (item: T) => string,
	options: FuzzyMatchOptions = PICKER_FUZZY_OPTIONS,
): T[] {
	return items
		.map((item, index) => {
			const score = fuzzyMatch(query, selectText(item), options);
			return score === null ? null : { item, score, index };
		})
		.filter((entry): entry is { item: T; score: number; index: number } => entry !== null)
		.sort((a, b) => a.score - b.score || a.index - b.index)
		.map((entry) => entry.item);
}
