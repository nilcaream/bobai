import path from "node:path";
import { initProject } from "./project";
import { createServer } from "./server";

const projectRoot = process.cwd();
const staticDir = path.resolve(import.meta.dir, "../../ui/dist");

const project = await initProject(projectRoot);
const server = createServer({ port: 0, staticDir });

console.log(`Project: ${project.id}`);
console.log(`http://localhost:${server.port}/bobai`);
