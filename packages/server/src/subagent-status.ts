export class SubagentStatus {
	private statuses = new Map<string, "running" | "done">();

	set(sessionId: string, status: "running" | "done"): void {
		this.statuses.set(sessionId, status);
	}

	get(sessionId: string): "running" | "done" | undefined {
		return this.statuses.get(sessionId);
	}

	getAll(): Map<string, "running" | "done"> {
		return new Map(this.statuses);
	}
}
