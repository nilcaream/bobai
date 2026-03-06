export type SubagentState = "running" | "done" | "error";

export class SubagentStatus {
	private statuses = new Map<string, SubagentState>();

	set(sessionId: string, status: SubagentState): void {
		this.statuses.set(sessionId, status);
	}

	get(sessionId: string): SubagentState | undefined {
		return this.statuses.get(sessionId);
	}

	getAll(): Map<string, SubagentState> {
		return new Map(this.statuses);
	}
}
