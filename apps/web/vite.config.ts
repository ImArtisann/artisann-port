import { fileURLToPath } from "node:url";
import { foldkit } from "@foldkit/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), "");
    const apiOrigin = env.PUBLIC_PORTFOLIO_API_URL || "https://presence.artisann.dev";
    return {
        plugins: [
            tailwindcss(),
            foldkit({
                ssr: {
                    clientEntry: "/src/entry.ts",
                    serverEntry: "/src/entry.server.ts",
                    build: { prerender: { paths: ["/"], origin: "https://www.artisann.dev" } },
                },
            }),
            {
                name: "portfolio:native-worker",
                enforce: "post",
                config: () => ({
                    environments: {
                        ssr: {
                            build: {
                                rolldownOptions: {
                                    input: {
                                        fetch: fileURLToPath(
                                            new URL("./src/worker.ts", import.meta.url),
                                        ),
                                    },
                                },
                            },
                        },
                    },
                }),
            },
        ],
        envPrefix: ["VITE_", "PUBLIC_"],
        define: { "import.meta.env.TRAKS_SITE_KEY": JSON.stringify(env.TRAKS_SITE_KEY ?? "") },
        ssr: { external: ["cloudflare:workers"] },
        build: { rolldownOptions: { external: ["cloudflare:workers"] } },
        server: {
            proxy: {
                "/api": { target: apiOrigin, changeOrigin: true, ws: true },
                "/presence": { target: apiOrigin, changeOrigin: true, ws: true },
                "/projects": { target: apiOrigin, changeOrigin: true },
            },
        },
    };
});
