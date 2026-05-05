import readline from "node:readline";

export async function promptText(prompt: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	return new Promise<string>((resolve, reject) => {
		rl.question(prompt, (answer) => {
			rl.close();
			resolve(answer.trim());
		});
		rl.on("error", (err) => {
			rl.close();
			reject(err);
		});
	});
}
