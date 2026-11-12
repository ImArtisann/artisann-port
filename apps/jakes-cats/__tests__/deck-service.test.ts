import { expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { CatsInternalApi } from "@artisann-port/cats-domain/cats-internal.api";
import { DeckService } from "../src/server/deck-service.ts";
import { MigrationService } from "../src/server/migration-service.ts";
import { ORIGINAL_TIME, catsWorld } from "./cats-world.ts";

it("removes deleted leaders before selecting the twenty highest live photos", async () => {
    const world = catsWorld();
    world.installCapture();
    world.objects.clear();
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const migration = yield* MigrationService;
                yield* migration.prepare;
                yield* migration.fence;
                yield* migration.handoff;
                const api = yield* CatsInternalApi.clientInProcess;
                for (let photo = 1; photo <= 23; photo++) {
                    const key = `cats/${123456789012345600n + BigInt(photo)}.webp`;
                    world.objects.set(key, new Date(ORIGINAL_TIME));
                    for (let visitor = 1; visitor <= photo; visitor++) {
                        yield* api.HeartPhoto(key, {
                            visitorId: visitor.toString(16).padStart(32, "0"),
                        });
                    }
                }
                yield* world.settle;
                world.objects.delete("cats/123456789012345623.webp");
                world.objects.delete("cats/123456789012345622.webp");
                const deck = yield* DeckService;
                const leaderboard = yield* deck.leaderboard("00000000000000000000000000000001");
                expect(leaderboard.entries).toHaveLength(20);
                expect(leaderboard.entries[0]).toMatchObject({
                    rank: 1,
                    photo: { key: "cats/123456789012345621.webp", likes: 21, hearted: true },
                });
                expect(leaderboard.entries[19]).toMatchObject({
                    rank: 20,
                    photo: { key: "cats/123456789012345602.webp", likes: 2 },
                });
                expect(
                    (yield* deck
                        .detail("123456789012345623", "00000000000000000000000000000001")
                        .pipe(Effect.flip))._tag,
                ).toBe("Deck.PhotoNotFound");
                expect(
                    (yield* deck.shuffled("00000000000000000000000000000001")).photos,
                ).toHaveLength(21);
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        world.db.sqlite.close();
    }
});
