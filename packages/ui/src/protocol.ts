export type ServerMessage =
	| { type: "token"; text: string; sessionId?: string }
	| { type: "tool_call"; id: string; output: string; sessionId?: string }
	| { type: "tool_result"; id: string; output: string | null; mergeable: boolean; summary?: string; sessionId?: string }
	| { type: "prompt_echo"; text: string; sessionId?: string }
	| { type: "done"; sessionId: string; model: string; title?: string | null; summary?: string }
	| { type: "error"; message: string; sessionId?: string }
	| { type: "status"; text: string; sessionId?: string }
	| { type: "session_created"; sessionId: string }
	| { type: "session_subscribed"; sessionId: string }
	| { type: "session_locked"; sessionId: string }
	| { type: "subagent_start"; sessionId: string; title: string; toolCallId: string }
	| { type: "subagent_done"; sessionId: string; model: string; summary?: string }
	| { type: "db_disconnected" };

export type RouteResult =
	| { target: "parent"; msg: ServerMessage }
	| { target: "child"; sessionId: string }
	| { target: "lifecycle"; msg: ServerMessage };

export type SubagentInfo = {
	sessionId: string;
	title: string;
	status: "running" | "done";
	toolCallId: string;
};

export type ProjectInfo = {
	dir: string;
	git?: { branch: string; revision: string };
};

export type StagedSkill = { name: string; content: string };

export type MessagePart =
	| { type: "text"; content: string }
	| { type: "tool_call"; id: string; content: string }
	| {
			type: "tool_result";
			id: string;
			content: string | null;
			mergeable: boolean;
			summary?: string;
			subagentSessionId?: string;
	  };

export type Message =
	| { role: "user"; text: string; timestamp: string }
	| { role: "assistant"; parts: MessagePart[]; timestamp?: string; model?: string; summary?: string };
