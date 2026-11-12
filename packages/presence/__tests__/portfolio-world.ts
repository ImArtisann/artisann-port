import { ContentState } from "@artisann-port/portfolio-domain/content/content-state";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Platform, type AggregateStore } from "@alchemy.run/domain/Platform";
import * as InMemory from "@alchemy.run/domain/InMemory";
import { Portfolio, PortfolioHandlers } from "@artisann-port/portfolio-domain/portfolio.model";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@artisann-port/portfolio-domain/content";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Redacted from "effect/Redacted";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { CmsBindings, CmsContentLive } from "../src/cms-service.ts";
import { KvContentDocumentsLive } from "../src/content-document-store.ts";
import { ContentWriterController } from "../src/content-writer-object.ts";
import type {
    ContentWriterAction,
    DurableObjectStorageLike,
    DurableObjectTransactionLike,
} from "../src/content-writer.ts";
import type { ContentMigrationSource } from "../src/content-migration-source.ts";
import { PortfolioMigrationLive } from "../src/content-migration-service.ts";
import { GithubBinding, GithubLive } from "../src/github.ts";
import { handlePortfolioHttp } from "../src/http-server.ts";
import { NotesConfig, NotesLive, NotesRateLimit } from "../src/notes-service.ts";
import { PhotoDomainLive } from "../src/photo-domain-service.ts";
import {
    PhotosBinding,
    PhotosConfig,
    PhotosLive,
    type PhotosR2MutationBinding,
    type PhotoStoredObject,
} from "../src/photos-service.ts";
import {
    PortfolioEnvironment,
    type PortfolioWorkerEnvironment,
} from "../src/portfolio-bindings.ts";
import { PresenceBinding, PresenceLive } from "../src/presence-service.ts";
import { UNINITIALIZED_SNAPSHOT } from "../src/schema.ts";
import type { PresenceKvBinding } from "../src/store.ts";
import { WeatherLive } from "../src/weather-service.ts";

export const NOW = "2026-11-12T04:00:00.000Z";
export const ORIGIN = "https://www.artisann.dev";
export const TOKEN = "isolated-portfolio-owner-token";
export const EPOCH = "portfolio-cutover-proof";
export const noteId = (number: number) => number.toString(16).padStart(32, "0");
export const approval = (number: number, body = `Published note ${number}`) => ({
    action: "approve" as const,
    id: noteId(number),
    name: "Ada",
    body,
    submittedAt: "2026-09-08T03:00:00.000Z",
});

export class MemoryKv implements PresenceKvBinding {
    readonly documents = new Map<string, string>();
    readonly writes: Array<{ key: string; value: string }> = [];
    failWrites = false;
    constructor(content: SiteContent) {
        this.documents.set("site-content", JSON.stringify(content));
    }
    get(key: string) {
        return Promise.resolve(this.documents.get(key) ?? null);
    }
    put(key: string, value: string) {
        if (this.failWrites) return Promise.reject(new Error("private KV diagnostic"));
        this.documents.set(key, value);
        this.writes.push({ key, value });
        return Promise.resolve();
    }
}

export class MemoryStorage implements DurableObjectStorageLike {
    private data = new Map<string, unknown>();
    private serialized: Promise<void> = Promise.resolve();
    alarm: number | null = null;
    private transactionView(data: Map<string, unknown>): DurableObjectTransactionLike {
        return {
            get: <T>(key: string) => {
                // SAFETY: native storage is opaque; each production reader decodes its own record.
                return Promise.resolve(structuredClone(data.get(key)) as T | undefined);
            },
            put: (key, value) => {
                data.set(key, structuredClone(value));
                return Promise.resolve();
            },
            delete: (key) => Promise.resolve(data.delete(key)),
            list: <T>(options: { prefix: string; startAfter?: string; limit: number }) => {
                const entries = [...data]
                    .filter(
                        ([key]) =>
                            key.startsWith(options.prefix) &&
                            (options.startAfter === undefined || key > options.startAfter),
                    )
                    .sort(([a], [b]) => a.localeCompare(b))
                    .slice(0, options.limit);
                // SAFETY: the list preserves the native generic storage contract without interpreting records.
                return Promise.resolve(new Map(structuredClone(entries)) as Map<string, T>);
            },
            setAlarm: (time) => {
                this.alarm = time instanceof Date ? time.getTime() : time;
                return Promise.resolve();
            },
            getAlarm: () => Promise.resolve(this.alarm),
        };
    }
    get<T>(key: string) {
        return this.transactionView(this.data).get<T>(key);
    }
    put<T>(key: string, value: T) {
        return this.transactionView(this.data).put(key, value);
    }
    delete(key: string) {
        return this.transactionView(this.data).delete(key);
    }
    list<T>(options: { prefix: string; startAfter?: string; limit: number }) {
        return this.transactionView(this.data).list<T>(options);
    }
    setAlarm(time: number | Date) {
        return this.transactionView(this.data).setAlarm(time);
    }
    getAlarm() {
        return Promise.resolve(this.alarm);
    }
    transaction<A>(callback: (storage: DurableObjectTransactionLike) => Promise<A>): Promise<A> {
        const result = this.serialized.then(async () => {
            const staged = structuredClone(this.data);
            const previousAlarm = this.alarm;
            try {
                const value = await callback(this.transactionView(staged));
                this.data = staged;
                return value;
            } catch (error) {
                this.alarm = previousAlarm;
                throw error;
            }
        });
        this.serialized = result.then(
            () => undefined,
            () => undefined,
        );
        return result;
    }
}

interface StoredPhoto extends PhotoStoredObject {
    readonly bytes: Uint8Array;
    readonly uploaded: Date;
    readonly httpMetadata: { readonly contentType: string; readonly cacheControl: string };
}
export class MemoryPhotos implements PhotosR2MutationBinding {
    readonly objects = new Map<string, StoredPhoto>();
    puts = 0;
    deletes = 0;
    head(key: string) {
        return Promise.resolve(this.objects.get(key) ?? null);
    }
    list(options: { prefix: string; cursor?: string; limit: number }) {
        const all = [...this.objects]
            .filter(([key]) => key.startsWith(options.prefix))
            .sort(([a], [b]) => a.localeCompare(b));
        const eligible = all.filter(
            ([key]) => options.cursor === undefined || key > options.cursor,
        );
        const selected = eligible.slice(0, options.limit);
        const truncated = eligible.length > selected.length;
        const page = {
            objects: selected.map(([key, object]) => ({ key, uploaded: object.uploaded })),
            truncated,
        };
        return Promise.resolve(truncated ? { ...page, cursor: selected.at(-1)?.[0] } : page);
    }
    put(key: string, bytes: Uint8Array, options: Parameters<PhotosR2MutationBinding["put"]>[2]) {
        if (options.onlyIf !== undefined && this.objects.has(key)) return Promise.resolve(null);
        const object = {
            bytes: bytes.slice(),
            uploaded: new Date(NOW),
            etag: `portfolio-photo-${++this.puts}`,
            customMetadata: { ...options.customMetadata },
            httpMetadata: { ...options.httpMetadata },
        };
        this.objects.set(key, object);
        return Promise.resolve(object);
    }
    delete(key: string) {
        this.deletes++;
        this.objects.delete(key);
        return Promise.resolve();
    }
}

interface PortfolioFaults {
    beforeFence?: () => Promise<void>;
    failComplete: boolean;
}

export function portfolioWorld(initial: SiteContent = DEFAULT_SITE_CONTENT) {
    const kv = new MemoryKv(initial);
    const storage = new MemoryStorage();
    const photos = new MemoryPhotos();
    let controller = new ContentWriterController({ storage }, { PRESENCE_KV: kv });
    const faults: PortfolioFaults = { failComplete: false };
    const source: ContentMigrationSource = {
        getState: () => controller.getState(),
        apply: (action) => controller.apply(action),
        migrationPrepare: (epoch) => controller.migrationPrepare(epoch),
        migrationStatus: () => controller.migrationStatus(),
        migrationBaseline: () => controller.migrationBaseline(),
        migrationEntries: (after, take) => controller.migrationEntries(after, take),
        migrationFence: async (epoch, sequence) => {
            await faults.beforeFence?.();
            return controller.migrationFence(epoch, sequence);
        },
        migrationComplete: (epoch, sequence) =>
            faults.failComplete
                ? Promise.reject(new Error("private completion transport failure"))
                : controller.migrationComplete(epoch, sequence),
    };
    const outgoing: Array<{ url: string; body: string }> = [];
    const http = HttpClient.make((request, url) =>
        Effect.sync(() => {
            outgoing.push({
                url: url.toString(),
                body:
                    request.body._tag === "Uint8Array"
                        ? new TextDecoder().decode(request.body.body)
                        : "",
            });
            const response = Match.value(url.hostname).pipe(
                Match.when("challenges.cloudflare.com", () =>
                    Response.json({
                        success: true,
                        hostname: "www.artisann.dev",
                        action: "submit-note",
                    }),
                ),
                Match.when("discord.com", () =>
                    Response.json({
                        id: "100000000000000009",
                        channel_id: "100000000000000004",
                    }),
                ),
                Match.when("api.open-meteo.com", () =>
                    Response.json({
                        current: { temperature_2m: 23.75 },
                        current_units: { temperature_2m: "°C" },
                    }),
                ),
                Match.orElse(() => new Response(null, { status: 502 })),
            );
            return HttpClientResponse.fromWeb(request, response);
        }),
    );
    let presence = UNINITIALIZED_SNAPSHOT;
    const presenceBinding = {
        getSnapshot: () => Promise.resolve(presence),
        publishSnapshot: (value: typeof presence) => {
            presence = value;
            return Promise.resolve(value);
        },
    };
    const env: PortfolioWorkerEnvironment = {
        PRESENCE_KV: kv,
        PHOTOS: photos,
        ASSETS_HOST: "assets.artisann.dev",
        CONTENT_WRITER_TOKEN: TOKEN,
        CONTENT_WRITER: { idFromName: (name) => ({ toString: () => name }), get: () => source },
        PRESENCE: {
            idFromName: (name) => ({ toString: () => name }),
            get: () => ({
                ...presenceBinding,
                fetch: () => Promise.resolve(new Response(null, { status: 426 })),
            }),
        },
        WEBSITE_ORIGIN: ORIGIN,
        DISCORD_NOTES_CHANNEL_ID: "100000000000000004",
        DISCORD_NOTES_WEBHOOK_URL:
            "https://discord.com/api/webhooks/100000000000000005/isolated-portfolio-webhook",
        TURNSTILE_SECRET_KEY: "isolated-portfolio-turnstile-secret",
        NOTES_RATE_LIMIT: { limit: () => Promise.resolve({ success: true }) },
    };
    const native = Layer.mergeAll(
        Layer.succeed(PortfolioEnvironment, env),
        Layer.succeed(CmsBindings, { snapshots: kv, writer: source }),
        Layer.succeed(PhotosBinding, photos),
        Layer.succeed(PhotosConfig, { assetsHost: env.ASSETS_HOST }),
        Layer.succeed(PresenceBinding, presenceBinding),
        Layer.succeed(GithubBinding, kv),
        Layer.succeed(NotesConfig, {
            websiteOrigin: ORIGIN,
            discordNotesChannelId: env.DISCORD_NOTES_CHANNEL_ID,
            discordNotesWebhookUrl: Redacted.make(env.DISCORD_NOTES_WEBHOOK_URL),
            turnstileSecretKey: Redacted.make(env.TURNSTILE_SECRET_KEY),
        }),
        Layer.succeed(NotesRateLimit, { binding: env.NOTES_RATE_LIMIT }),
        Layer.succeed(HttpClient.HttpClient, http),
    );
    const memory = InMemory.make({ now: () => Date.parse(NOW) });
    const stores = new Map<string, AggregateStore>();
    const diagnostics = Layer.effect(
        Platform,
        Effect.gen(function* () {
            const platform = yield* Platform;
            return Platform.of({
                model: (model) =>
                    platform.model(model).pipe(
                        Effect.map((host) => ({
                            ...host,
                            aggregate: (aggregate, kit) =>
                                host.aggregate(aggregate, kit).pipe(
                                    Effect.tap((store) =>
                                        Effect.sync(() => {
                                            stores.set(aggregate.aggregateName, store);
                                        }),
                                    ),
                                ),
                        })),
                    ),
            });
        }),
    ).pipe(Layer.provide(memory.layer));
    const documents = KvContentDocumentsLive.pipe(Layer.provideMerge(native));
    const hosted = Portfolio.layer(PortfolioHandlers).pipe(
        Layer.provideMerge(Layer.mergeAll(documents, diagnostics)),
    );
    const photoDomain = PhotoDomainLive.pipe(Layer.provideMerge(hosted));
    const layer = Layer.mergeAll(
        CmsContentLive,
        PortfolioMigrationLive,
        PhotosLive,
        PresenceLive,
        GithubLive,
        NotesLive,
        WeatherLive,
    ).pipe(Layer.provideMerge(photoDomain));
    return {
        layer,
        kv,
        storage,
        photos,
        source,
        faults,
        outgoing,
        memory,
        history: (aggregate: string, id: string) =>
            Effect.suspend(() => {
                const events = stores.get(aggregate)?.events;
                if (events === undefined)
                    return Effect.die(
                        new Error(`Missing in-memory event diagnostics for ${aggregate}`),
                    );
                return events(id).pipe(
                    Effect.flatMap(
                        Effect.forEach((entry) =>
                            Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Json))(
                                entry.event,
                            ).pipe(
                                Effect.map((event) => ({ ...entry, event })),
                                Effect.orDie,
                            ),
                        ),
                    ),
                );
            }),
        published: (revision: number) =>
            Stream.unwrap(
                Effect.sync(() => {
                    const store = stores.get("SiteContent");
                    if (store === undefined)
                        throw new Error("Missing in-memory content diagnostics");
                    return store.changes("site-content");
                }),
            ).pipe(
                Stream.mapEffect((snapshot) =>
                    Schema.decodeUnknownEffect(ContentState)(snapshot.state).pipe(Effect.orDie),
                ),
                Stream.filter((state) => state.active && state.publishedRevision >= revision),
                Stream.runHead,
                Effect.timeout("2 seconds"),
                Effect.orDie,
            ),
        restartSource: () => {
            const old = controller;
            controller = new ContentWriterController({ storage }, { PRESENCE_KV: kv });
            return old;
        },
    };
}

export function publicGet(path = "/api/content") {
    return handlePortfolioHttp(new Request(`https://portfolio.invalid${path}`));
}
export function ownerRequest(
    path: string,
    body?:
        | ContentWriterAction
        | { readonly epoch?: string; readonly take?: number; readonly after?: number },
    id = "owner-proof",
) {
    const options: RequestInit = {
        method: body === undefined ? "GET" : "POST",
        headers: {
            authorization: `Bearer ${TOKEN}`,
            "content-type": "application/json",
            "x-command-id": id,
        },
    };
    if (body !== undefined) options.body = JSON.stringify(body);
    return handlePortfolioHttp(new Request(`https://portfolio.invalid${path}`, options));
}
