import { fileURLToPath } from "node:url";
import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";

export const Likes = Cloudflare.D1.Database(
    "Likes",
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        return {
            name: stage === "prod" ? "jakes-cats-likes" : `jakes-cats-likes-${stage}`,
            migrations: fileURLToPath(new URL("../../migrations", import.meta.url)),
        };
    }),
);
