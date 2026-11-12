import * as Alchemy from "alchemy";
import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { PRESENCE_KV_TITLE } from "./config.ts";

export const Snapshots = Cloudflare.KV.Namespace(
    "Snapshots",
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        return { title: stage === "prod" ? PRESENCE_KV_TITLE : `${PRESENCE_KV_TITLE}-${stage}` };
    }),
);
