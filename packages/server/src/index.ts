import { createServer } from "./server";

const server = createServer({ port: 0 });
console.log(`http://localhost:${server.port}/bobai`);
