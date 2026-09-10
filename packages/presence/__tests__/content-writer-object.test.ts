import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { CONTENT_KEY } from "../src/config.ts";
import { DEFAULT_SITE_CONTENT, MAX_NOTES, type SiteContent } from "../src/content.ts";
import type {
    ApproveAction,
    ContentWriterAction,
    ContentWriterErrorKind,
    ContentWriterResult,
    ContentWriterState,
    DurableObjectStateLike,
    DurableObjectStorageLike,
} from "../src/content-writer.ts";
import { ContentWriterController } from "../src/content-writer-object.ts";
import type { PresenceKvBinding } from "../src/store.ts";

const noteId = (n: number) => n.toString(16).padStart(32, "0");
const seedNote = (n: number) => ({
    id: noteId(n),
    name: null,
    body: `Note ${n}`,
    submittedAt: "2026-09-08T03:00:00.000Z",
    approvedAt: "2026-09-08T03:01:00.000Z",
});
const approveAction = (n: number, body = "Great site"): ApproveAction => ({
    action: "approve",
    id: noteId(n),
    name: null,
    body,
    submittedAt: "2026-09-08T03:00:00.000Z",
});

/** Map-backed Durable Object state double: storage plus introspection. */
interface StoredStateFixture {
    readonly revision: number;
    readonly publishedRevision: number;
    readonly document: string;
    readonly dirty: boolean;
}

interface RejectionMarkerFixture {
    readonly id: string;
    readonly decision: string;
}

type MemoryStoredValue = StoredStateFixture | RejectionMarkerFixture;

const decodeStoredValue = Schema.decodeUnknownSync(
    Schema.Union([
        Schema.Struct({
            revision: Schema.Finite,
            publishedRevision: Schema.Finite,
            document: Schema.String,
            dirty: Schema.Boolean,
        }),
        Schema.Struct({ id: Schema.String, decision: Schema.String }),
    ]),
);
const decodeStoredState = Schema.decodeUnknownSync(
    Schema.Struct({
        revision: Schema.Finite,
        publishedRevision: Schema.Finite,
        document: Schema.String,
        dirty: Schema.Boolean,
    }),
);

interface MemoryStorageData {
    [key: string]: MemoryStoredValue | undefined;
}

function memoryState(): DurableObjectStateLike & {
    readonly data: MemoryStorageData;
    readonly alarms: number[];
} {
    const data: MemoryStorageData = {};
    const alarms: number[] = [];
    const storage: DurableObjectStorageLike = {
        // Test double: values are stored opaquely and re-served unchanged.
        get: async <T>(key: string) => {
            // SAFETY: the production storage contract writes only the two
            // MemoryStoredValue variants, and each caller requests its known
            // value for the corresponding key.
            return data[key] as T | undefined;
        },
        put: (key, value) => {
            data[key] = decodeStoredValue(value);
            return Promise.resolve();
        },
        delete: (key) => {
            delete data[key];
            return Promise.resolve(true);
        },
        setAlarm: (time) => {
            alarms.push(time instanceof Date ? time.getTime() : time);
            return Promise.resolve();
        },
        getAlarm: () => Promise.resolve(alarms.at(-1) ?? null),
    };
    return { storage, data, alarms };
}

interface KvDouble extends PresenceKvBinding {
    readonly puts: readonly string[];
}

function kvDouble(documents: Record<string, string>): KvDouble {
    const puts: string[] = [];
    return {
        get: (key) => Promise.resolve(documents[key] ?? null),
        put: (key, value) => {
            puts.push(key);
            documents[key] = value;
            return Promise.resolve();
        },
        puts,
    };
}

it("canonicalizes legacy authority before an alarm-first dirty projection", async () => {
    const state = memoryState();
    const { experience: _experience, facts: _facts, ...legacy } = DEFAULT_SITE_CONTENT;
    state.data.state = {
        revision: 7,
        publishedRevision: 6,
        dirty: true,
        document: JSON.stringify(legacy),
    };
    const documents: Record<string, string> = {};
    await new ContentWriterController(state, { PRESENCE_KV: kvDouble(documents) }).alarm();
    const published = JSON.parse(documents[CONTENT_KEY] ?? "null");
    expect(published.experience).toEqual(DEFAULT_SITE_CONTENT.experience);
    expect(published.facts).toEqual(DEFAULT_SITE_CONTENT.facts);
    expect(state.data.state).toMatchObject({ revision: 7, publishedRevision: 7, dirty: false });
});

function writer(documents: Record<string, string>) {
    const doState = memoryState();
    const kv = kvDouble(documents);
    return { doState, kv, instance: new ContentWriterController(doState, { PRESENCE_KV: kv }) };
}

async function getState(instance: ContentWriterController): Promise<ContentWriterState> {
    return await instance.getState();
}

async function post(
    instance: ContentWriterController,
    body: ContentWriterAction,
): Promise<ContentWriterResult | { readonly error: ContentWriterErrorKind }> {
    return await instance.apply(body);
}

function successful(
    result: ContentWriterResult | { readonly error: ContentWriterErrorKind },
): ContentWriterResult {
    if ("error" in result) {
        throw new Error(`expected a successful result, got ${result.error}`);
    }
    return result;
}

describe("ContentWriterController bootstrap", () => {
    it("adopts the KV document as revision 1 on first read", async () => {
        const { kv, instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });

        const state = await getState(instance);

        expect(state.revision).toBe(1);
        expect(state.publishedRevision).toBe(1);
        expect(state.content).toEqual(DEFAULT_SITE_CONTENT);
        expect(kv.puts).toEqual([]);
    });

    it("bootstraps from defaults when KV is empty", async () => {
        const { instance } = writer({});

        const state = await getState(instance);

        expect(state.content).toEqual(DEFAULT_SITE_CONTENT);
    });

    it("canonicalizes an existing legacy record without changing authority metadata", async () => {
        const {
            experience: _experience,
            facts: _facts,
            ...withoutCollections
        } = DEFAULT_SITE_CONTENT;
        const legacy = {
            ...withoutCollections,
            apps: DEFAULT_SITE_CONTENT.apps.map(({ ogImageHosts: _hosts, ...app }) => app),
        };
        const doState = memoryState();
        const kv = kvDouble({});
        doState.data.state = {
            revision: 17,
            publishedRevision: 12,
            document: JSON.stringify(legacy),
            dirty: true,
        };
        const instance = new ContentWriterController(doState, { PRESENCE_KV: kv });

        const state = await getState(instance);
        const persisted = decodeStoredState(doState.data.state);

        expect(state.content).toEqual(DEFAULT_SITE_CONTENT);
        expect(persisted.revision).toBe(17);
        expect(persisted.publishedRevision).toBe(12);
        expect(persisted.dirty).toBe(true);
        expect(JSON.parse(persisted.document)).toEqual(DEFAULT_SITE_CONTENT);
    });
});

describe("ContentWriterController approval", () => {
    it("approves a pending note, bumps the revision, and projects to KV", async () => {
        const { kv, instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });

        const result = await post(instance, approveAction(1, "Great site"));
        const parsed = successful(result);
        expect(parsed.outcome).toBe("approved");
        expect(parsed.state.revision).toBe(2);
        expect(parsed.state.publishedRevision).toBe(2);
        expect(kv.puts).toEqual([CONTENT_KEY]);
        const state = await getState(instance);
        expect(state.content.notes).toHaveLength(1);
        expect(state.content.notes[0]).toMatchObject({
            id: noteId(1),
            name: null,
            body: "Great site",
            submittedAt: "2026-09-08T03:00:00.000Z",
        });
    });

    it("answers a repeated identical approval without another projection", async () => {
        const { kv, instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });
        await post(instance, approveAction(1));
        const putsAfterFirst = kv.puts.length;

        const result = await post(instance, approveAction(1));
        const parsed = successful(result);

        expect(parsed.outcome).toBe("already-approved");
        expect(kv.puts.length).toBe(putsAfterFirst);
    });

    it("refuses a conflicting payload for an already-published id", async () => {
        const { instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });
        await post(instance, approveAction(1));

        const result = await post(instance, approveAction(1, "Different text"));

        expect(result).toEqual({ error: "validation" });
    });

    it("reports capacity instead of evicting a published note", async () => {
        const full = {
            ...DEFAULT_SITE_CONTENT,
            notes: Array.from({ length: MAX_NOTES }, (_, i) => seedNote(i + 1)),
        };
        const { instance } = writer({ [CONTENT_KEY]: JSON.stringify(full) });

        const result = await post(instance, approveAction(999, "One too many"));

        expect(result).toEqual({ error: "capacity" });
        const state = await getState(instance);
        expect(state.content.notes).toHaveLength(MAX_NOTES);
    });
});

describe("ContentWriterController deletion", () => {
    it("removes only the selected note, advances authority, and publishes the deletion", async () => {
        const content = {
            ...DEFAULT_SITE_CONTENT,
            notes: [seedNote(1), seedNote(2), seedNote(3)],
            updatedAt: "2099-01-01T00:00:00.000Z",
        };
        const documents = { [CONTENT_KEY]: JSON.stringify(content) };
        const { instance, doState, kv } = writer(documents);
        const before = await getState(instance);

        const result = successful(await post(instance, { action: "delete", id: noteId(2) }));

        expect(result.outcome).toBe("deleted");
        expect(result.state.revision).toBe(before.revision + 1);
        expect(result.state.publishedRevision).toBe(result.state.revision);
        expect(result.state.content.notes).toEqual([seedNote(1), seedNote(3)]);
        expect(result.state.content.updatedAt).toBe("2099-01-01T00:00:00.001Z");
        expect(JSON.parse(documents[CONTENT_KEY] ?? "null")).toEqual(result.state.content);
        expect(kv.puts).toEqual([CONTENT_KEY]);
        const restarted = new ContentWriterController(doState, { PRESENCE_KV: kv });
        expect(await getState(restarted)).toEqual(result.state);
    });

    it("returns not-found without changing authority or projecting when the id is absent", async () => {
        const documents = {
            [CONTENT_KEY]: JSON.stringify({ ...DEFAULT_SITE_CONTENT, notes: [seedNote(1)] }),
        };
        const { instance, kv } = writer(documents);
        const before = await getState(instance);
        const published = documents[CONTENT_KEY];

        const result = successful(await post(instance, { action: "delete", id: noteId(2) }));

        expect(result.outcome).toBe("not-found");
        expect(result.state).toEqual(before);
        expect(documents[CONTENT_KEY]).toBe(published);
        expect(kv.puts).toEqual([]);
    });

    it("keeps deletion unconfirmed until the alarm publishes its durable removal", async () => {
        const documents = {
            [CONTENT_KEY]: JSON.stringify({ ...DEFAULT_SITE_CONTENT, notes: [seedNote(1)] }),
        };
        const kv = kvDouble(documents);
        let healthy = false;
        const instance = new ContentWriterController(memoryState(), {
            PRESENCE_KV: {
                get: (key) => kv.get(key),
                put: (key, value) =>
                    healthy ? kv.put(key, value) : Promise.reject(new Error("kv down")),
            },
        });

        expect(await post(instance, { action: "delete", id: noteId(1) })).toEqual({
            error: "unavailable",
        });
        expect((await getState(instance)).content.notes).toEqual([]);
        expect(JSON.parse(documents[CONTENT_KEY] ?? "null").notes).toEqual([seedNote(1)]);
        expect(await post(instance, { action: "delete", id: noteId(1) })).toEqual({
            error: "unavailable",
        });

        healthy = true;
        await instance.alarm();

        const retried = successful(await post(instance, { action: "delete", id: noteId(1) }));
        expect(retried.outcome).toBe("not-found");
        expect(retried.state.publishedRevision).toBe(retried.state.revision);
        expect(JSON.parse(documents[CONTENT_KEY] ?? "null").notes).toEqual([]);
    });

    it("keeps a deleted note deleted when a stale approval retries its id", async () => {
        const documents = {
            [CONTENT_KEY]: JSON.stringify({ ...DEFAULT_SITE_CONTENT, notes: [seedNote(1)] }),
        };
        const { instance } = writer(documents);

        const deleted = successful(await post(instance, { action: "delete", id: noteId(1) }));
        expect(deleted.outcome).toBe("deleted");
        const revision = deleted.state.revision;

        const retried = successful(await post(instance, approveAction(1)));

        expect(retried.outcome).toBe("not-found");
        expect(retried.state.revision).toBe(revision);
        expect(retried.state.content.notes).toEqual([]);
        expect(retried.state.publishedRevision).toBe(retried.state.revision);
        expect(JSON.parse(documents[CONTENT_KEY] ?? "null").notes).toEqual([]);
    });
});

describe("ContentWriterController rejection", () => {
    it("marks the id without touching content or KV, and stays final", async () => {
        const { kv, doState, instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });

        const first = await post(instance, { action: "reject", id: noteId(2) });
        const second = await post(instance, { action: "reject", id: noteId(2) });

        expect(first).toMatchObject({ outcome: "rejected" });
        expect(second).toMatchObject({ outcome: "already-rejected" });
        expect(kv.puts).toEqual([]);
        const state = await getState(instance);
        expect(state.content.notes).toEqual([]);
        // The marker stores only the decision, never the visitor text.
        expect(doState.data[`rejected:${noteId(2)}`]).toEqual({
            id: noteId(2),
            decision: "rejected",
        });
    });

    it("answers an approve for a rejected id without publishing", async () => {
        const { kv, instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });
        await post(instance, { action: "reject", id: noteId(2) });

        const result = await post(instance, approveAction(2));
        const parsed = successful(result);

        expect(parsed.outcome).toBe("already-rejected");
        expect(kv.puts).toEqual([]);
        const state = await getState(instance);
        expect(state.content.notes).toEqual([]);
    });

    it("refuses to reject an already-published id even from fresh state", async () => {
        const { instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });
        await post(instance, approveAction(3));

        const result = await post(instance, { action: "reject", id: noteId(3) });

        // Refused as a success outcome: the review message was already
        // finalized by the approval, and rejection is never retroactive.
        const parsed = successful(result);
        expect(parsed.outcome).toBe("already-approved");
        const state = await getState(instance);
        expect(state.content.notes).toHaveLength(1);
    });

    it("holds a reject of a published id open while its projection is unconfirmed", async () => {
        let healthy = false;
        let putAttempts = 0;
        const kv: PresenceKvBinding = {
            get: (key) =>
                Promise.resolve(key === CONTENT_KEY ? JSON.stringify(DEFAULT_SITE_CONTENT) : null),
            put: () => {
                putAttempts++;
                return healthy ? Promise.resolve() : Promise.reject(new Error("kv down"));
            },
        };
        const instance = new ContentWriterController(memoryState(), { PRESENCE_KV: kv });
        const action = approveAction(8, "Uncertain approval");
        await post(instance, action);
        const attemptsBeforeReject = putAttempts;
        healthy = true;

        // The approval is durable but the mirror is unconfirmed: rejecting it
        // must NOT finalize "Approved" — 503, zero KV writes, controls stay.
        const heldOpen = await post(instance, { action: "reject", id: noteId(8) });
        expect(heldOpen).toEqual({ error: "unavailable" });
        expect(putAttempts).toBe(attemptsBeforeReject);

        await instance.alarm();
        const confirmed = await post(instance, { action: "reject", id: noteId(8) });
        const parsed = successful(confirmed);
        expect(parsed.outcome).toBe("already-approved");
    });
});

describe("ContentWriterController replace", () => {
    it("replaces content under CAS and preserves notes exactly", async () => {
        const { instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });
        await post(instance, approveAction(1, "Keep me"));
        const state = await getState(instance);

        const result = await post(instance, {
            action: "replace",
            revision: state.revision,
            content: {
                ...state.content,
                records: { bench: 330, squat: 490, deadlift: 530 },
            },
        });
        const parsed = successful(result);

        expect(parsed.outcome).toBe("updated");
        expect(parsed.state.content.records).toEqual({ bench: 330, squat: 490, deadlift: 530 });
        expect(parsed.state.content.notes).toEqual(state.content.notes);
        expect(parsed.state.revision).toBe(state.revision + 1);
    });

    it("stamps a strictly monotonic updatedAt on every authority commit", async () => {
        const { instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });

        const first = await post(instance, approveAction(11, "First"));
        const afterFirst = successful(first).state;
        const firstReplace = await post(instance, {
            action: "replace",
            revision: afterFirst.revision,
            content: { ...afterFirst.content, records: { bench: 330, squat: 490, deadlift: 530 } },
        });
        const afterReplace = successful(firstReplace).state;

        expect(afterFirst.content.updatedAt).not.toBeNull();
        expect(afterReplace.content.updatedAt === null).toBe(false);
        expect(Date.parse(afterReplace.content.updatedAt ?? "")).toBeGreaterThan(
            Date.parse(afterFirst.content.updatedAt ?? ""),
        );
    });

    it("rejects a stale revision with 409 and a note mutation with 422", async () => {
        const { instance } = writer({
            [CONTENT_KEY]: JSON.stringify(DEFAULT_SITE_CONTENT),
        });
        const state = await getState(instance);

        const stale = await post(instance, {
            action: "replace",
            revision: state.revision + 5,
            content: state.content,
        });
        const notesMutation = await post(instance, {
            action: "replace",
            revision: state.revision,
            content: { ...state.content, notes: [seedNote(1)] },
        });

        expect(stale).toEqual({ error: "conflict" });
        expect(notesMutation).toEqual({ error: "validation" });
    });
});

describe("ContentWriterController projection reconciliation", () => {
    it("keeps the mutation durable and arms the alarm when KV refuses", async () => {
        let healthy = false;
        const kv: PresenceKvBinding = {
            get: (key) =>
                Promise.resolve(key === CONTENT_KEY ? JSON.stringify(DEFAULT_SITE_CONTENT) : null),
            put: () => (healthy ? Promise.resolve() : Promise.reject(new Error("kv down"))),
        };
        const doState = memoryState();
        const instance = new ContentWriterController(doState, { PRESENCE_KV: kv });

        const result = await post(instance, approveAction(4, "Durable"));

        expect(result).toEqual({ error: "unavailable" });
        expect(await doState.storage.getAlarm()).not.toBeNull();

        const dirty = await getState(instance);
        expect(dirty.revision).toBe(2);
        expect(dirty.publishedRevision).toBe(1);
        expect(dirty.content.notes).toHaveLength(1);

        healthy = true;
        await instance.alarm();

        const reconciled = await getState(instance);
        expect(reconciled.publishedRevision).toBe(2);
        expect(reconciled.content.notes[0]).toMatchObject({ id: noteId(4) });

        // A repeated approval now answers already-approved instead of publishing twice.
        const repeated = await post(instance, approveAction(4, "Durable"));
        const parsed = successful(repeated);
        expect(parsed.outcome).toBe("already-approved");
        expect(reconciled.content.notes).toHaveLength(1);
    });

    it("keeps a repeated approval pending until the projection is accepted", async () => {
        let healthy = false;
        const kv: PresenceKvBinding = {
            get: (key) =>
                Promise.resolve(key === CONTENT_KEY ? JSON.stringify(DEFAULT_SITE_CONTENT) : null),
            put: () => (healthy ? Promise.resolve() : Promise.reject(new Error("kv down"))),
        };
        const instance = new ContentWriterController(memoryState(), { PRESENCE_KV: kv });
        const action = approveAction(5, "Pending");
        await post(instance, action);

        // The first mutation is durable-but-dirty: the mirror is unconfirmed.
        const dirtyState = await getState(instance);
        expect(dirtyState.publishedRevision).toBe(1);

        // So a repeated approval cannot claim publication while dirty, even
        // though the note already exists in the authoritative document.
        const stillDown = await post(instance, action);
        expect(stillDown).toEqual({ error: "unavailable" });

        healthy = true;
        await instance.alarm();
        const repeated = await post(instance, action);
        const parsed = successful(repeated);
        expect(parsed.outcome).toBe("already-approved");
        expect(parsed.state.publishedRevision).toBe(parsed.state.revision);
    });

    it("reconciles the LATEST authority when the alarm runs after newer mutations", async () => {
        const kvDocuments = new Map<string, string>([
            [CONTENT_KEY, JSON.stringify(DEFAULT_SITE_CONTENT)],
        ]);
        let healthy = false;
        const kv: PresenceKvBinding = {
            get: (key) => Promise.resolve(kvDocuments.get(key) ?? null),
            put: (key, value) => {
                if (!healthy) return Promise.reject(new Error("kv down"));
                kvDocuments.set(key, value);
                return Promise.resolve();
            },
        };
        const instance = new ContentWriterController(memoryState(), { PRESENCE_KV: kv });

        // Two durable-but-unprojected authorities while KV is down: the stale
        // alarm must project revision 3 (the latest authority), never the
        // revision-2 snapshot it was originally armed for.
        await post(instance, approveAction(6, "Note six"));
        const beforeReplace = await getState(instance);
        const replaceResult = await post(instance, {
            action: "replace",
            revision: beforeReplace.revision,
            content: {
                ...beforeReplace.content,
                records: { bench: 340, squat: 500, deadlift: 540 },
            },
        });
        expect(replaceResult).toEqual({ error: "unavailable" });

        healthy = true;
        await instance.alarm();

        const projected: SiteContent = JSON.parse(kvDocuments.get(CONTENT_KEY)!);
        expect(projected.records).toEqual({ bench: 340, squat: 500, deadlift: 540 });
        expect(projected.notes).toHaveLength(1);
        expect(projected.notes[0]).toMatchObject({ id: noteId(6) });
        const finalState = await getState(instance);
        expect(finalState.revision).toBe(3);
        expect(finalState.publishedRevision).toBe(3);
    });
});
