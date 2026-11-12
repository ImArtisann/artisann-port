/**
 * Runs a command against a loopback Portfolio API that serves the compiled seed content.
 *
 *   bun apps/web/scripts/with-seed-content.ts bun run build
 *
 * CI uses it so the build step never depends on the deployed backend. Production deploys
 * build against the freshly deployed backend and still fail closed on unavailable content.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { DEFAULT_SITE_CONTENT, SiteContent } from "@artisann-port/portfolio-domain/content";
import * as Schema from "effect/Schema";

const [command, ...args] = process.argv.slice(2);
if (command === undefined) throw new Error("usage: with-seed-content.ts <command> [...args]");

const PORT = 4319;
const body = JSON.stringify(Schema.encodeSync(SiteContent)(DEFAULT_SITE_CONTENT));
const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/content") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(body);
        return;
    }
    response.writeHead(404);
    response.end();
});

server.listen(PORT, "127.0.0.1", () => {
    const child = spawn(command, args, {
        stdio: "inherit",
        env: { ...process.env, PUBLIC_PORTFOLIO_API_URL: `http://127.0.0.1:${PORT}` },
    });
    child.on("exit", (code) => {
        server.close();
        process.exitCode = code ?? 1;
    });
});
