function formatDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function formatTimestamp(): string {
	return formatDate(new Date());
}

export function formatStoredTimestamp(iso: string): string {
	return formatDate(new Date(iso));
}
