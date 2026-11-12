import pages from "virtual:foldkit/fetch";
import type { CatsWorkerEnv } from "./ssr.ts";

export default {
    fetch(request: Request, env: CatsWorkerEnv): Promise<Response> {
        const path = new URL(request.url).pathname;
        return path === "/api" || path.startsWith("/api/")
            ? env.CATS.fetch(request)
            : pages.fetch(request);
    },
};
