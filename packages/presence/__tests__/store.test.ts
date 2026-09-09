import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Option from "effect/Option";
import { DocumentStoreError, kvDocumentStore } from "../src/store.ts";

const TOKEN = "super-secret-kv-token";

const KEY = "site-content";

describe("native KV binding store", () => {
    it("reports failures as a sanitized error without the failing value", async () => {
        const namespace = {
            get: () => Promise.reject(new Error(`kv exploded with ${TOKEN}`)),
            put: () => Promise.reject(new Error(`kv exploded with ${TOKEN}`)),
        };
        const store = kvDocumentStore(namespace, KEY);

        const read = await Effect.runPromise(Effect.result(store.read));
        const write = await Effect.runPromise(Effect.result(store.write("{}")));

        const outcomes: Array<Result.Result<unknown, DocumentStoreError>> = [read, write];
        expect(outcomes.every((outcome) => Result.isFailure(outcome))).toBe(true);
        for (const result of outcomes) {
            if (Result.isFailure(result)) {
                expect(result.failure).toBeInstanceOf(DocumentStoreError);
                expect(result.failure.status).toBeNull();
                expect(JSON.stringify(result.failure)).not.toContain(TOKEN);
            }
        }
    });

    it("keeps missing keys distinct from failed reads", async () => {
        const store = kvDocumentStore(
            { get: () => Promise.resolve(null), put: () => Promise.resolve() },
            KEY,
        );

        const document = await Effect.runPromise(store.read);

        expect(Option.isNone(document)).toBe(true);
    });
});
