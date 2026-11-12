import pages from "virtual:foldkit/fetch";
import { isPortfolioRequest, type PortfolioEnvironment } from "./ssr.ts";
export { prerenderPaths, renderDocument, renderPage } from "./entry.server.ts";

export default {
    fetch(request: Request, env: PortfolioEnvironment): Promise<Response> {
        return isPortfolioRequest(request) ? env.PORTFOLIO.fetch(request) : pages.fetch(request);
    },
};
