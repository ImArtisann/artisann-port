/** @jsxImportSource react */
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { renderToString } from "react-dom/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AtomRegistry from "effect/unstable/reactivity/AtomRegistry";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import { ApiUnavailable } from "@artisann-port/presence/api-errors";
import { DEFAULT_SITE_CONTENT, type SiteContent } from "@artisann-port/presence/content";
import { PublicRpcs } from "@artisann-port/presence/rpc";
import { SharedAtomRegistry } from "../src/lib/atom-registry.tsx";
import { contentAtom, photoAtom } from "../src/lib/rpc-client.ts";
import { useSiteContent } from "../src/lib/content-client.ts";
import { PresenceStatus, MusicStatus } from "../src/components/portfolio/presence-widgets.tsx";

const registries: AtomRegistry.AtomRegistry[] = [];
const routes = new Map<string, (request: Request) => Promise<Response>>();
let attemptedRequests = 0;
const dispatchFetch = (input: string | URL | Request, init?: RequestInit) => {
    attemptedRequests++;
    const request =
        input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    const route = routes.get(request.url);
    return route ? route(request) : Promise.reject(new Error("Unexpected fixture endpoint"));
};
afterEach(() => {
    for (const registry of registries.splice(0)) registry.dispose();
    routes.clear();
    attemptedRequests = 0;
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

function fixture() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const registry = AtomRegistry.make({ defaultIdleTTL: 0, timeoutResolution: 1 });
    registries.push(registry);
    let document = DEFAULT_SITE_CONTENT;
    let contentReads = 0;
    let photoReads = 0;
    let pending = false;
    let contentStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
        contentStarted = resolve;
    });
    const signals: AbortSignal[] = [];
    const handlers = PublicRpcs.toLayer({
        "content.get": () =>
            Effect.suspend(() => {
                contentReads++;
                contentStarted();
                return pending ? Effect.never : Effect.succeed(document);
            }),
        "photos.list": ({ tag, cursor }) =>
            Effect.sync(() => {
                photoReads++;
                return cursor === undefined
                    ? { tag, photos: [], nextCursor: "second" }
                    : {
                          tag,
                          photos: [
                              {
                                  key: `${tag}/10000000000000001.webp`,
                                  url: `https://assets.artisann.dev/${tag}/10000000000000001.webp`,
                                  uploadedAt: "2026-09-09T00:00:00.000Z",
                              },
                          ],
                          nextCursor: null,
                      };
            }),
        "weather.get": () => Effect.succeed({ temperature: 24, unit: "°C" }),
        "github.get": () => Effect.fail(new ApiUnavailable({ operation: "github.get" })),
    });
    const serve = HttpEffect.toWebHandler(
        RpcServer.toHttpEffect(PublicRpcs).pipe(
            Effect.flatten,
            Effect.provide(Layer.mergeAll(handlers, RpcSerialization.layerNdjson)),
        ),
    );
    routes.set("http://localhost:1338/rpc", (request) => {
        signals.push(request.signal);
        return serve(request);
    });
    vi.stubGlobal("fetch", dispatchFetch);
    return {
        registry,
        signals,
        started,
        contentReads: () => contentReads,
        photoReads: () => photoReads,
        update: (next: SiteContent) => {
            document = next;
        },
        hang: () => {
            pending = true;
        },
    };
}

function ContentProbe({ initial }: { initial: SiteContent }) {
    return <span>{useSiteContent(initial).records.bench}</span>;
}

describe("shared Astro Atom lifetime", () => {
    it("keeps SSR render roots isolated and performs no request or socket acquisition", () => {
        let sockets = 0;
        vi.stubGlobal("fetch", dispatchFetch);
        vi.stubGlobal(
            "WebSocket",
            class {
                constructor() {
                    sockets++;
                }
            },
        );
        const render = (bench: number) =>
            renderToString(
                <SharedAtomRegistry>
                    <ContentProbe
                        initial={{
                            ...DEFAULT_SITE_CONTENT,
                            records: { ...DEFAULT_SITE_CONTENT.records, bench },
                        }}
                    />
                    <PresenceStatus />
                    <MusicStatus />
                </SharedAtomRegistry>,
            );
        expect(render(111)).toContain("111");
        expect(render(222)).toContain("222");
        expect(attemptedRequests).toBe(0);
        expect(sockets).toBe(0);
    });

    it("shares content reads and observes remote edits on a mounted refresh", async () => {
        const world = fixture();
        const atom = contentAtom("http://localhost:1338/rpc");
        const leaveFirst = world.registry.mount(atom);
        const leaveSecond = world.registry.mount(atom);
        await Effect.runPromise(AtomRegistry.getResult(world.registry, atom));
        expect(world.contentReads()).toBe(1);
        world.update({
            ...DEFAULT_SITE_CONTENT,
            records: { ...DEFAULT_SITE_CONTENT.records, bench: 499 },
        });
        await vi.advanceTimersByTimeAsync(60_000);
        const refreshed = await Effect.runPromise(
            AtomRegistry.getResult(world.registry, atom, { suspendOnWaiting: true }),
        );
        expect(refreshed.records.bench).toBe(499);
        expect(world.contentReads()).toBe(2);
        leaveFirst();
        leaveSecond();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(world.contentReads()).toBe(2);
    });

    it("retains a cached result after unmount and revalidates a stale remount", async () => {
        const world = fixture();
        world.update({
            ...DEFAULT_SITE_CONTENT,
            records: { ...DEFAULT_SITE_CONTENT.records, bench: 333 },
        });
        const atom = contentAtom("http://localhost:1338/rpc");
        const leave = world.registry.mount(atom);
        await Effect.runPromise(AtomRegistry.getResult(world.registry, atom));
        await vi.advanceTimersByTimeAsync(50_000);
        leave();
        await vi.advanceTimersByTimeAsync(20_000);
        world.update({
            ...DEFAULT_SITE_CONTENT,
            records: { ...DEFAULT_SITE_CONTENT.records, bench: 612 },
        });
        const leaveAgain = world.registry.mount(atom);
        expect(world.registry.get(atom)).toMatchObject({
            _tag: "Success",
            value: { records: { bench: 333 } },
        });
        await vi.advanceTimersByTimeAsync(0);
        const fresh = await Effect.runPromise(
            AtomRegistry.getResult(world.registry, atom, { suspendOnWaiting: true }),
        );
        expect(fresh.records.bench).toBe(612);
        expect(world.contentReads()).toBe(2);
        leaveAgain();
    });

    it("shares one complete photo page walk across duplicate life galleries", async () => {
        const world = fixture();
        const atom = photoAtom("life", "http://localhost:1338/rpc");
        const first = world.registry.mount(atom);
        const second = world.registry.mount(photoAtom("life", "http://localhost:1338/rpc"));
        const photos = await Effect.runPromise(AtomRegistry.getResult(world.registry, atom));
        expect(photos.map((photo) => photo.key)).toEqual(["life/10000000000000001.webp"]);
        expect(world.photoReads()).toBe(2);
        await vi.advanceTimersByTimeAsync(60_000);
        await Effect.runPromise(
            AtomRegistry.getResult(world.registry, atom, { suspendOnWaiting: true }),
        );
        expect(world.photoReads()).toBe(4);
        first();
        second();
    });

    it("interrupts an in-flight request when the unobserved source cache expires", async () => {
        const world = fixture();
        world.hang();
        const atom = contentAtom("http://localhost:1338/rpc");
        const leave = world.registry.mount(atom);
        await world.started;
        expect(world.contentReads()).toBe(1);
        leave();
        // Dispose the zero-idle refresh/SWR wrappers before advancing the retained source.
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(60_001);
        // Flush the expired node's zero-idle dependency finalizers.
        await vi.runOnlyPendingTimersAsync();
        expect(world.signals[0]?.aborted).toBe(true);
        expect(world.contentReads()).toBe(1);
    });
});
