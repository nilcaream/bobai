import path from "node:path";
import { createServer } from "./server";

const staticDir = path.resolve(import.meta.dir, "../../ui/dist");

const server = createServer({ port: 0, staticDir });
console.log(`http://localhost:${server.port}/bobai`);
