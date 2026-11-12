import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Match from "effect/Match";
import {
    PhotoOperationId,
    PhotoWriter,
} from "@artisann-port/portfolio-domain/photo/photo-operation";
import {
    ApiUnavailable,
    ContentWriteError,
    NoteSubmissionError,
    WriterUnauthorized,
} from "./api-errors.ts";
import { CmsContentService } from "./cms-service.ts";
import { ContentWriterAction, CONTENT_WRITER_BODY_BYTES_MAX } from "./content-writer.ts";
import { PortfolioMigration } from "./content-migration-service.ts";
import { ContentMigrationFailure } from "./content-migration-source.ts";
import { GithubService } from "./github.ts";
import { HttpRequestFailure, readJsonRequest, readRequestBody } from "./http-body.ts";
import { NotesService, originAllowed } from "./notes-service.ts";
import { RawNoteSubmission, type NoteSubmissionAccepted } from "./notes.ts";
import { PhotoMutationError } from "./photo-domain-service.ts";
import { PhotosService, PhotoReconciliationRequest } from "./photos-service.ts";
import { PhotoTag } from "./photos.ts";
import { PortfolioEnvironment } from "./portfolio-bindings.ts";
import { PresenceService } from "./presence-service.ts";
import { PresenceSnapshot } from "./schema.ts";
import { projectPreviewResponse, type ProjectImageCache } from "./project-preview.ts";
import { WeatherService } from "./weather-service.ts";

declare const caches: { readonly default: ProjectImageCache };

export const publicCorsHeaders = {
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, traceparent, tracestate, x-domain-subscription",
};

type HttpFailure =
    | HttpRequestFailure
    | ApiUnavailable
    | ContentWriteError
    | NoteSubmissionError
    | WriterUnauthorized
    | PhotoMutationError
    | ContentMigrationFailure;

export function jsonResponse(
    data: Schema.Json,
    status = 200,
    headers: Readonly<Record<string, string>> = publicCorsHeaders,
): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...headers,
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
    });
}

export function errorResponse(error: HttpFailure): Response {
    switch (error._tag) {
        case "HttpRequestFailure":
            return jsonResponse({ _tag: error._tag, code: error.code }, error.status);
        case "ApiUnavailable":
            return jsonResponse({ _tag: error._tag, operation: error.operation }, 503);
        case "WriterUnauthorized":
            return jsonResponse({ _tag: error._tag }, 401, { "cache-control": "no-store" });
        case "ContentWriteError":
            return jsonResponse(
                { _tag: error._tag, kind: error.kind },
                Match.value(error.kind).pipe(
                    Match.when("conflict", () => 409),
                    Match.when("unavailable", () => 503),
                    Match.orElse(() => 422),
                ),
                { "cache-control": "no-store" },
            );
        case "NoteSubmissionError":
            return jsonResponse(
                { _tag: error._tag, reason: error.reason },
                Match.value(error.reason).pipe(
                    Match.when("invalid", () => 400),
                    Match.when("forbidden", () => 403),
                    Match.when("throttled", () => 429),
                    Match.orElse(() => 503),
                ),
                { "cache-control": "no-store" },
            );
        case "PhotoMutationError":
            return jsonResponse(
                { _tag: error._tag, reason: error.reason, outcome: error.outcome },
                error.reason === "Unauthorized"
                    ? 401
                    : error.reason === "TooLarge"
                      ? 413
                      : error.reason === "InvalidKey" || error.reason === "InvalidImage"
                        ? 400
                        : error.reason === "Collision" || error.reason === "OperationConflict"
                          ? 409
                          : 503,
                { "cache-control": "no-store" },
            );
        case "ContentMigrationFailure":
            return jsonResponse(
                { _tag: error._tag, reason: error.reason },
                Match.value(error.reason).pipe(
                    Match.when("unavailable", () => 503),
                    Match.when("invalid", () => 400),
                    Match.orElse(() => 409),
                ),
                { "cache-control": "no-store" },
            );
    }
}

const commandId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
const MigrationPrepare = Schema.Struct({
    epoch: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
});
const MigrationPage = Schema.Struct({
    take: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
const MigrationExport = Schema.Struct({
    after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    take: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});

function parameter<A, I>(schema: Schema.Codec<A, I>, input: Schema.Json) {
    return Schema.decodeUnknownEffect(schema)(input).pipe(
        Effect.mapError(() => new HttpRequestFailure({ status: 400, code: "InvalidRequest" })),
    );
}

export const handlePortfolioHttp = Effect.fn("Portfolio.http")(
    function* (request: Request) {
        const env = yield* PortfolioEnvironment;
        const url = new URL(request.url);
        const path = url.pathname;
        const writer = path.startsWith("/api/writer/") || path.startsWith("/api/migration/");
        const notes = path === "/api/notes";
        const origin = request.headers.get("origin");
        if (
            writer &&
            (env.CONTENT_WRITER_TOKEN.length === 0 ||
                request.headers.get("authorization") !== `Bearer ${env.CONTENT_WRITER_TOKEN}`)
        )
            return yield* new WriterUnauthorized();
        if (notes && (origin === null || !originAllowed(origin, env.WEBSITE_ORIGIN)))
            return yield* new NoteSubmissionError({ reason: "forbidden" });
        if (request.method === "OPTIONS" && !writer) {
            return new Response(null, {
                status: 204,
                headers: notes
                    ? {
                          ...publicCorsHeaders,
                          "access-control-allow-origin": origin ?? "",
                          vary: "Origin",
                      }
                    : publicCorsHeaders,
            });
        }

        const cms = yield* CmsContentService;
        if (path === "/api/content" && request.method === "GET")
            return jsonResponse(yield* cms.get);
        if (path === "/api/photos" && request.method === "GET") {
            const photos = yield* PhotosService;
            const tag = yield* parameter(PhotoTag, url.searchParams.get("tag"));
            const cursor = url.searchParams.get("cursor");
            if (cursor !== null && cursor.length > 4096)
                return yield* new HttpRequestFailure({ status: 400, code: "InvalidRequest" });
            return jsonResponse(yield* photos.listPage(tag, cursor ?? undefined));
        }
        if (path === "/api/github" && request.method === "GET")
            return jsonResponse(yield* (yield* GithubService).get);
        if (path === "/api/weather" && request.method === "GET")
            return jsonResponse(yield* (yield* WeatherService).get);
        if (notes && request.method === "POST") {
            const input = yield* readJsonRequest(
                request,
                RawNoteSubmission.annotate({ parseOptions: { onExcessProperty: "error" } }),
                8 * 1024,
            );
            const reviewFailure = () => new NoteSubmissionError({ reason: "unavailable" });
            // The composer retries with the same id; a recorded review means the note is already
            // delivered, so answer as accepted instead of posting a second review message.
            if (yield* cms.reviewQueued(input.id).pipe(Effect.mapError(reviewFailure)))
                return jsonResponse(
                    { status: "pending", id: input.id } satisfies NoteSubmissionAccepted,
                    200,
                    {
                        ...publicCorsHeaders,
                        "access-control-allow-origin": origin ?? "",
                        vary: "Origin",
                    },
                );
            const submitted = yield* (yield* NotesService).submit(input, {
                origin,
                ip: request.headers.get("cf-connecting-ip"),
            });
            yield* cms.recordReview(submitted.id).pipe(Effect.mapError(reviewFailure));
            return jsonResponse(submitted, 200, {
                ...publicCorsHeaders,
                "access-control-allow-origin": origin ?? "",
                vary: "Origin",
            });
        }
        if (path === "/api/writer/content" && request.method === "GET")
            return jsonResponse(yield* cms.readState, 200, { "cache-control": "no-store" });
        if (path === "/api/writer/content" && request.method === "POST") {
            const id = yield* parameter(commandId, request.headers.get("x-command-id"));
            const action = yield* readJsonRequest(
                request,
                ContentWriterAction,
                CONTENT_WRITER_BODY_BYTES_MAX,
            );
            return jsonResponse(yield* cms.apply(action, id), 200, { "cache-control": "no-store" });
        }
        if (path === "/api/writer/presence" && request.method === "GET")
            return jsonResponse(yield* (yield* PresenceService).get, 200, {
                "cache-control": "no-store",
            });
        if (path === "/api/writer/presence" && request.method === "POST") {
            const snapshot = yield* readJsonRequest(request, PresenceSnapshot, 16 * 1024);
            return jsonResponse(yield* (yield* PresenceService).publish(snapshot), 200, {
                "cache-control": "no-store",
            });
        }
        if (path === "/api/writer/photos/reconcile" && request.method === "POST") {
            const input = yield* readJsonRequest(request, PhotoReconciliationRequest, 8 * 1024);
            return jsonResponse(
                yield* (yield* PhotosService).reconcile({ ...input, actor: "owner" }),
                200,
                { "cache-control": "no-store" },
            );
        }
        if (
            path === "/api/writer/photos" &&
            (request.method === "POST" || request.method === "DELETE")
        ) {
            const photos = yield* PhotosService;
            const id = yield* parameter(
                PhotoOperationId,
                request.headers.get("x-photo-operation-id"),
            );
            const actor = yield* parameter(
                PhotoWriter,
                request.headers.get("x-photo-writer") ?? "owner",
            );
            const key = url.searchParams.get("key") ?? "";
            if (request.method === "DELETE") {
                const etag = request.headers.get("if-match");
                const expectedUpload = request.headers.get("x-photo-expected-operation-id");
                return jsonResponse(
                    yield* photos.delete({
                        key,
                        operationId: id,
                        actor,
                        expectedEtag: etag ?? undefined,
                        expectedUploadOperationId:
                            expectedUpload === null
                                ? undefined
                                : yield* parameter(PhotoOperationId, expectedUpload),
                    }),
                    200,
                    { "cache-control": "no-store" },
                );
            }
            const tag = yield* parameter(PhotoTag, url.searchParams.get("tag"));
            const bytes = yield* readRequestBody(request, 32 * 1024 * 1024);
            const receipt = yield* photos.upload({
                key,
                tag,
                bytes,
                operationId: id,
                actor,
                mode: request.headers.get("if-none-match") === "*" ? "create-only" : "replace",
            });
            return jsonResponse(receipt, 201, { "cache-control": "no-store" });
        }
        if (path.startsWith("/api/migration/")) {
            const migration = yield* PortfolioMigration;
            if (path === "/api/migration/status" && request.method === "GET")
                return jsonResponse(yield* migration.status, 200, { "cache-control": "no-store" });
            if (request.method !== "POST")
                return new Response(null, {
                    status: 405,
                    headers: { "cache-control": "no-store" },
                });
            if (path === "/api/migration/prepare") {
                const input = yield* readJsonRequest(request, MigrationPrepare, 8 * 1024);
                return jsonResponse(yield* migration.prepare(input.epoch), 200, {
                    "cache-control": "no-store",
                });
            }
            if (path === "/api/migration/import") {
                const input = yield* readJsonRequest(request, MigrationPage, 8 * 1024);
                return jsonResponse(yield* migration.importPage(input.take ?? 100), 200, {
                    "cache-control": "no-store",
                });
            }
            if (path === "/api/migration/export") {
                const input = yield* readJsonRequest(request, MigrationExport, 8 * 1024);
                return jsonResponse(yield* migration.exportPage(input.after, input.take), 200, {
                    "cache-control": "no-store",
                });
            }
            if (path === "/api/migration/handoff") {
                const state = yield* migration.handoff;
                return jsonResponse(
                    state,
                    state.target.publishedRevision < state.target.revision ? 202 : 200,
                    { "cache-control": "no-store" },
                );
            }
        }
        // The preview handler owns its method contract: GET, HEAD, otherwise 405.
        if (path.startsWith("/projects/"))
            return yield* projectPreviewResponse(request, caches.default, yield* cms.get).pipe(
                Effect.mapError(() => new ApiUnavailable({ operation: "projects.og-image" })),
            );
        const recognized = [
            "/api/content",
            "/api/photos",
            "/api/github",
            "/api/weather",
            "/api/notes",
            "/api/writer/content",
            "/api/writer/presence",
            "/api/writer/photos",
            "/api/writer/photos/reconcile",
        ].includes(path);
        return new Response(null, {
            status: recognized ? 405 : 404,
            headers: { "cache-control": "no-store" },
        });
    },
    (effect, request) =>
        Effect.gen(function* () {
            const env = yield* PortfolioEnvironment;
            const response = yield* effect.pipe(
                Effect.tapDefect(() => Effect.logError("Portfolio HTTP request failed")),
                Effect.catchDefect(() => Effect.fail(new ApiUnavailable({ operation: "request" }))),
                Effect.match({ onFailure: errorResponse, onSuccess: (result) => result }),
            );
            const path = new URL(request.url).pathname;
            if (path.startsWith("/api/writer/") || path.startsWith("/api/migration/")) {
                response.headers.delete("access-control-allow-origin");
                response.headers.delete("access-control-allow-methods");
                response.headers.delete("access-control-allow-headers");
            }
            const origin = request.headers.get("origin");
            if (
                path === "/api/notes" &&
                origin !== null &&
                originAllowed(origin, env.WEBSITE_ORIGIN)
            ) {
                response.headers.set("access-control-allow-origin", origin);
                response.headers.set("vary", "Origin");
            }
            return response;
        }),
);
