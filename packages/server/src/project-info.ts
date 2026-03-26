import path from "node:path";

export interface ProjectInfo {
	dir: string;
	git?: { branch: string; revision: string };
}

const GIT_TIMEOUT_MS = 5_000;

async function runGit(args: string[], cwd: string): Promise<string | null> {
	try {
		const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		let timerId: ReturnType<typeof setTimeout> | undefined;
		const result = await Promise.race([
			proc.exited.then((code) => ({ kind: "done" as const, code })),
			new Promise<"timeout">((resolve) => {
				timerId = setTimeout(() => resolve("timeout"), GIT_TIMEOUT_MS);
			}),
		]);
		clearTimeout(timerId);
		if (result === "timeout") {
			proc.kill();
			return null;
		}
		if (result.code !== 0) return null;
		const text = await new Response(proc.stdout).text();
		return text.trim() || null;
	} catch {
		return null;
	}
}

export async function getProjectInfo(projectRoot: string): Promise<ProjectInfo> {
	const segments = projectRoot.split(path.sep).filter(Boolean);
	const dir = segments.slice(-2).join("/");

	const [branch, revision] = await Promise.all([
		runGit(["branch", "--show-current"], projectRoot),
		runGit(["rev-parse", "--short", "HEAD"], projectRoot),
	]);

	if (branch && revision) {
		return { dir, git: { branch, revision } };
	}
	return { dir };
}
