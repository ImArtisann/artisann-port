import { WorkerEnvironment } from "@alchemy.run/cloudflare";
import * as Effect from "effect/Effect";
import { PhotoIndex } from "@artisann-port/cats-domain/photo-index.projection";
import type { CatsWorkerEnv } from "../env.ts";

export const PhotoIndexLive = PhotoIndex.toLayer(
    Effect.gen(function* () {
        const native = yield* WorkerEnvironment;
        // SAFETY: CatsBackend declares the LIKES D1 binding in its Worker environment.
        const env = native as CatsWorkerEnv;
        const database = env.LIKES;
        return Effect.fn("Cats.PhotoIndex")(function* (batch) {
            const statements = batch.map(({ key, event }) =>
                event._tag === "HeartRecorded"
                    ? database
                          .prepare(
                              "INSERT INTO cats_domain_hearts (photo_key, visitor_id, created_at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING",
                          )
                          .bind(key.id, event.visitorId, event.createdAt)
                    : database
                          .prepare(
                              "INSERT INTO cats_domain_comments (photo_key, id, visitor_id, body, created_at) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT DO NOTHING",
                          )
                          .bind(
                              key.id,
                              event.comment.id,
                              event.comment.visitorId,
                              event.comment.body,
                              event.comment.createdAt,
                          ),
            );
            if (statements.length !== 0) {
                const results = yield* Effect.promise(() => database.batch(statements));
                if (results.some((result) => !result.success))
                    return yield* Effect.die(new Error("Cats projection write failed"));
            }
        });
    }),
);
