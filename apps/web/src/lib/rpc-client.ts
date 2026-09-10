import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Atom from "effect/unstable/reactivity/Atom";
import * as AtomRpc from "effect/unstable/reactivity/AtomRpc";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import {
    isPortfolioApiOrigin,
    PORTFOLIO_API_ORIGIN,
    portfolioEndpoints,
} from "@artisann-port/presence/config";
import { collectPhotos, type PhotoTag } from "@artisann-port/presence/photos";
import { NotesRpcs, PublicRpcs } from "@artisann-port/presence/rpc";
import { publicRpcProtocol } from "@artisann-port/presence/rpc-transport";

const configuredOrigin = (import.meta.env.PUBLIC_PORTFOLIO_API_URL ?? PORTFOLIO_API_ORIGIN).trim();
if (!isPortfolioApiOrigin(configuredOrigin))
    throw new Error("PUBLIC_PORTFOLIO_API_URL must be a valid portfolio API origin");
export const portfolioApiOrigin = new URL(configuredOrigin).origin;
export const portfolioApiEndpoints = portfolioEndpoints(configuredOrigin);

export const publicClientFor = Atom.family((endpoint: string) => {
    class PublicClient extends AtomRpc.Service<PublicClient>()(`Portfolio.PublicRpc:${endpoint}`, {
        group: PublicRpcs,
        protocol: publicRpcProtocol(endpoint).pipe(Layer.provide(FetchHttpClient.layer)),
        disableTracing: true,
    }) {}
    return PublicClient;
});

export const notesClientFor = Atom.family((endpoint: string) => {
    class NotesClient extends AtomRpc.Service<NotesClient>()(`Portfolio.NotesRpc:${endpoint}`, {
        group: NotesRpcs,
        protocol: publicRpcProtocol(endpoint).pipe(Layer.provide(FetchHttpClient.layer)),
        disableTracing: true,
    }) {}
    return NotesClient;
});

export const NotesClient = notesClientFor(portfolioApiEndpoints.notesRpcUrl);

export const contentAtom = Atom.family((endpoint: string) => {
    const client = publicClientFor(endpoint);
    return client
        .query("content.get", {}, { reactivityKeys: ["content"], timeToLive: "60 seconds" })
        .pipe(
            Atom.swr({ staleTime: "60 seconds", revalidateOnMount: true }),
            Atom.setIdleTTL(0),
            Atom.withRefresh("60 seconds"),
            Atom.setIdleTTL(0),
            Atom.withServerValueInitial,
        );
});

function makePhotoAtom(tag: PhotoTag, endpoint: string) {
    const client = publicClientFor(endpoint);
    return client.runtime
        .atom(
            Effect.gen(function* () {
                const rpc = yield* client;
                return yield* collectPhotos(tag, (cursor) =>
                    rpc("photos.list", cursor === undefined ? { tag } : { tag, cursor }).pipe(
                        Effect.timeout("10 seconds"),
                    ),
                );
            }),
        )
        .pipe(
            client.runtime.factory.withReactivity([`photos:${tag}`]),
            Atom.setIdleTTL("60 seconds"),
            Atom.swr({ staleTime: "60 seconds", revalidateOnMount: true }),
            Atom.setIdleTTL(0),
            Atom.withRefresh("60 seconds"),
            Atom.setIdleTTL(0),
            Atom.withServerValueInitial,
        );
}

// Keep the two family functions strongly rooted. A weakly cached outer family can
// otherwise disappear while its returned aggregate atom is still mounted.
const photoAtoms = {
    life: Atom.family((endpoint: string) => makePhotoAtom("life", endpoint)),
    cats: Atom.family((endpoint: string) => makePhotoAtom("cats", endpoint)),
};

/** Both life-gallery placements share one aggregate, not separately cached cursor pages. */
export function photoAtom(tag: PhotoTag, endpoint: string) {
    return photoAtoms[tag](endpoint);
}

export const githubAtom = Atom.family((endpoint: string) =>
    publicClientFor(endpoint)
        .query("github.get", {}, { timeToLive: "15 minutes" })
        .pipe(
            Atom.swr({ staleTime: "15 minutes", revalidateOnMount: true }),
            Atom.setIdleTTL(0),
            Atom.withRefresh("15 minutes"),
            Atom.setIdleTTL(0),
            Atom.withServerValueInitial,
        ),
);

export const weatherAtom = Atom.family((endpoint: string) =>
    publicClientFor(endpoint)
        .query("weather.get", {}, { timeToLive: "15 minutes" })
        .pipe(
            Atom.swr({ staleTime: "15 minutes", revalidateOnMount: true }),
            Atom.setIdleTTL(0),
            Atom.withRefresh("15 minutes"),
            Atom.setIdleTTL(0),
            Atom.withServerValueInitial,
        ),
);
