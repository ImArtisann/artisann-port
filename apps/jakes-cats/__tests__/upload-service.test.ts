import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import * as Redacted from "effect/Redacted";
import { MAX_UPLOAD_BYTES } from "../src/contracts.ts";
import { handleCatsRequest } from "../src/server/http.ts";
import { UploadService } from "../src/server/upload-service.ts";
import { WEBP_BYTES, uploadWorld } from "./upload-world.ts";

const TOKEN = Redacted.make("test-writer-token");
const request = (body: BodyInit, authorized = true) =>
    new Request("https://jakes.cat/api/photos?tag=cats", {
        method: "POST",
        headers: authorized ? { authorization: "Bearer test-writer-token" } : {},
        body,
    });
describe("permanent iPhone upload API through the photo owner", () => {
    it("authenticates before reading or transcoding and retains the 201 raw upload contract", async () => {
        const world = uploadWorld();
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const refused = yield* handleCatsRequest(
                        request(new Uint8Array([1, 2, 3]), false),
                        TOKEN,
                    );
                    expect(refused.status).toBe(401);
                    expect(world.script.transforms).toBe(0);
                    const created = yield* handleCatsRequest(
                        request(new Uint8Array([1, 2, 3])),
                        TOKEN,
                    );
                    expect(created.status).toBe(201);
                    const body = yield* Effect.promise(() => created.json());
                    expect(body).toMatchObject({ tag: "cats", likes: 0 });
                    expect(world.objects.size).toBe(1);
                    const key = world.script.uploads[0] ?? "";
                    expect(world.objects.get(key)?.bytes).toEqual(WEBP_BYTES);
                    expect(world.db.sqlite.prepare("SELECT key FROM photos").get()).toEqual({
                        key,
                    });
                    expect(created.headers.get("set-cookie")).toContain("jc_visitor=");
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
    it("rerolls only collisions without overwriting their objects", async () => {
        const world = uploadWorld();
        world.script.collideOnce = true;
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const uploaded = yield* (yield* UploadService).upload("cats", WEBP_BYTES);
                    expect(world.script.uploads).toHaveLength(2);
                    expect(world.objects.get(world.script.uploads[0] ?? "")?.bytes).toEqual(
                        new Uint8Array([9, 8, 7]),
                    );
                    expect(world.objects.get(uploaded.key)?.bytes).toEqual(WEBP_BYTES);
                    expect(
                        world.db.sqlite.prepare("SELECT COUNT(*) AS count FROM photos").get(),
                    ).toEqual({ count: 1 });
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
    it("rerolls a key minted by another upload instead of replaying its operation", async () => {
        const world = uploadWorld();
        world.script.outputs.push(WEBP_BYTES, Uint8Array.from([...WEBP_BYTES, 1]));
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    yield* TestClock.setTime(Date.UTC(2026, 10, 12));
                    const uploads = yield* UploadService;
                    const first = yield* uploads
                        .upload("cats", WEBP_BYTES)
                        .pipe(Random.withSeed("same-millisecond"));
                    const second = yield* uploads
                        .upload("cats", WEBP_BYTES)
                        .pipe(Random.withSeed("same-millisecond"));
                    expect(world.script.uploads[1]).toBe(first.key);
                    expect(second.key).not.toBe(first.key);
                    expect(world.objects.get(first.key)?.bytes).toEqual(WEBP_BYTES);
                    expect(world.objects.get(second.key)?.bytes).toEqual(
                        Uint8Array.from([...WEBP_BYTES, 1]),
                    );
                }).pipe(
                    Effect.scoped,
                    Effect.provide(world.layer),
                    Effect.provide(TestClock.layer()),
                ),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
    it("compensates a failed registry claim through the owner and never reports failed cleanup as success", async () => {
        for (const failDelete of [false, true]) {
            const world = uploadWorld();
            world.db.sqlite.exec("DROP TABLE photos");
            world.script.failDelete = failDelete;
            try {
                await Effect.runPromise(
                    Effect.gen(function* () {
                        const response = yield* handleCatsRequest(request(WEBP_BYTES), TOKEN);
                        expect(response.status).toBe(503);
                        expect(world.script.deletes).toEqual(world.script.uploads);
                        expect(world.objects.size).toBe(failDelete ? 1 : 0);
                        expect(yield* Effect.promise(() => response.json())).toEqual({
                            error: {
                                code: "unavailable",
                                message: "Photo storage is unavailable; try again.",
                            },
                        });
                    }).pipe(Effect.scoped, Effect.provide(world.layer)),
                );
            } finally {
                world.db.sqlite.close();
            }
        }
    });
    it("does not reroll, register or falsely compensate an uncertain owner result", async () => {
        const world = uploadWorld();
        world.script.uncertainOnce = true;
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const response = yield* handleCatsRequest(request(WEBP_BYTES), TOKEN);
                    expect(response.status).toBe(503);
                    expect(world.script.uploads).toHaveLength(1);
                    expect(world.script.deletes).toHaveLength(0);
                    expect(
                        world.db.sqlite.prepare("SELECT COUNT(*) AS count FROM photos").get(),
                    ).toEqual({ count: 0 });
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
    it("refuses oversized streamed input and invalid Images output before owner mutation", async () => {
        const world = uploadWorld();
        try {
            await Effect.runPromise(
                Effect.gen(function* () {
                    const upload = yield* UploadService;
                    const large = new ReadableStream<Uint8Array>({
                        start: (controller) => {
                            controller.enqueue(new Uint8Array(MAX_UPLOAD_BYTES + 1));
                            controller.close();
                        },
                    });
                    expect((yield* upload.upload("cats", large).pipe(Effect.flip)).reason).toBe(
                        "TooLarge",
                    );
                    expect(world.script.transforms).toBe(0);
                    world.script.invalidImage = true;
                    expect(
                        (yield* upload.upload("cats", WEBP_BYTES).pipe(Effect.flip)).reason,
                    ).toBe("InvalidImage");
                    expect(world.script.uploads).toHaveLength(0);
                }).pipe(Effect.scoped, Effect.provide(world.layer)),
            );
        } finally {
            world.db.sqlite.close();
        }
    });
});

it("selects the named photo file from multipart uploads and exposes the new object on the next deck read", async () => {
    const world = uploadWorld();
    const form = new FormData();
    form.append("other", new File([new Uint8Array([9, 9])], "other.jpg", { type: "image/jpeg" }));
    form.append("photo", new File([new Uint8Array([4, 5, 6])], "cat.jpg", { type: "image/jpeg" }));
    try {
        await Effect.runPromise(
            Effect.gen(function* () {
                const response = yield* handleCatsRequest(request(form), TOKEN);
                expect(response.status).toBe(201);
                expect(world.script.received).toEqual([[4, 5, 6]]);
                const deck = yield* handleCatsRequest(
                    new Request("https://jakes.cat/api/deck"),
                    TOKEN,
                );
                expect(yield* Effect.promise(() => deck.text())).toContain(world.script.uploads[0]);
            }).pipe(Effect.scoped, Effect.provide(world.layer)),
        );
    } finally {
        world.db.sqlite.close();
    }
});
