import path from "node:path";
import { resolvePort } from "./port";
import { initProject } from "./project";
import { createServer } from "./server";

const projectRoot = process.cwd();
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");

const project = await initProject(projectRoot);
const port = resolvePort(process.argv.slice(2), { port: project.port });
const server = createServer({ port, staticDir });

console.log(`Project: ${project.id}`);
console.log(`http://localhost:${server.port}/bobai`);
