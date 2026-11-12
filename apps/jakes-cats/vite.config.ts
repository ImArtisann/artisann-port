import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

const workerInput = { fetch: fileURLToPath(new URL("./src/worker.ts", import.meta.url)) };

export default defineConfig({
    // Cloudflare reads the entry before post-plugin config runs to claim the dev SSR environment.
    environments: {
        ssr: { build: { rolldownOptions: { input: workerInput } } },
    },
    plugins: [
        tailwindcss(),
        foldkit({
            ssr: {
                clientEntry: "/src/entry.ts",
                serverEntry: "/src/entry.server.ts",
                build: true,
            },
        }),
        {
            // Foldkit generates this entry only for builds; native dev uses the same public renderer.
            name: "cats:native-dev",
            apply: "serve",
            resolveId(id) {
                return id === "virtual:foldkit/fetch" ? "\0cats:native-dev" : undefined;
            },
            load(id) {
                if (id !== "\0cats:native-dev") return;
                return `
                    import { handleRequest } from "foldkit/experimental/server";
                    import { renderPage, renderDocument } from "/src/entry.server.ts";
                    export default {
                        fetch: (request) => handleRequest(request, {
                            renderPage,
                            renderDocument: (application) => renderDocument(application, {
                                entryScript: "/src/entry.ts",
                                stylesheets: ["/src/styles.css"],
                                modulePreloads: [],
                            }).replace("</head>", '<script type="module" src="/@vite/client"></script></head>'),
                        }),
                    };
                `;
            },
        },
        {
            name: "cats:native-worker",
            enforce: "post",
            config: () => ({
                environments: {
                    ssr: {
                        build: {
                            rolldownOptions: {
                                input: workerInput,
                            },
                        },
                    },
                },
            }),
        },
    ],
    build: { rolldownOptions: { external: ["cloudflare:workers"] } },
});
