/**
 * Secret-gated photo upload for the owner. One endpoint, one purpose: take a
 * photo from an iOS Shortcut share sheet and put it in the site's managed
 * `cats/` collection.
 *
 * iOS Shortcut recipe
 * -------------------
 * 1. Share Sheet: receive Images (or Files).
 * 2. Convert Image → JPEG (Cloudflare Images rejects HEIC input, so this step
 *    is required for photos taken on iPhone).
 * 3. Get Contents of URL:
 *    - URL: `https://jakes.cat/api/photos?tag=cats`
 *    - Method: POST
 *    - Headers: `Authorization: Bearer <CONTENT_WRITER_TOKEN>`
 *    - Request Body: File
 * 4. The response is `{ key, url, tag, likes }` for the stored WebP; the photo
 *    appears in the deck on the next visit.
 *
 * The token is the same `CONTENT_WRITER_TOKEN` the presence Worker accepts, so
 * it is never embedded in this bundle.
 */
import { createFileRoute } from "@tanstack/react-router";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { PhotoTag } from "@artisann-port/presence/photos";
import { MAX_UPLOAD_BYTES, type UploadResult } from "../contracts.ts";
import { env } from "../env.ts";
import { isAuthorized } from "../server/auth.ts";
import { capRequestBody, isBodyTooLarge } from "../server/body-limit.ts";
import { runServer } from "../server/layer.ts";
import { UploadError, UploadService } from "../server/upload-service.ts";

/** JSON error body; `code` is stable, `message` is for the Shortcut's author. */
interface ApiErrorBody {
    readonly error: { readonly code: string; readonly message: string };
}

type ApiBody = ApiErrorBody | UploadResult;

/**
 * Multipart framing (boundaries, headers, field names) rides on top of the
 * file itself, so a declared length is only rejected well past the real cap.
 * This ceiling bounds the framing a parser may buffer; the file bytes inside
 * still have to satisfy the smaller `MAX_UPLOAD_BYTES` cap.
 */
const MULTIPART_FRAMING_BYTES = 64 * 1024;

const isPhotoTag = Schema.is(PhotoTag);

/** A multipart field that carries bytes rather than text. */
const UploadFile = Schema.instanceOf(File);
const decodeUploadFile = Schema.decodeUnknownOption(UploadFile);

function errorBody(code: string, message: string): ApiErrorBody {
    return { error: { code, message } };
}

function jsonResponse(status: number, body: ApiBody, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
            ...headers,
        },
    });
}

/** The failure a client can act on, mapped from the upload's reason. */
function uploadFailureResponse(error: UploadError): Response {
    switch (error.reason) {
        case "TooLarge":
            return jsonResponse(
                413,
                errorBody("too_large", `Photos must be at most ${MAX_UPLOAD_BYTES} bytes.`),
            );
        case "InvalidImage":
            return jsonResponse(
                400,
                errorBody(
                    "invalid_image",
                    "That body is not a readable image. Convert HEIC photos to JPEG before uploading.",
                ),
            );
        case "Unavailable":
            return jsonResponse(
                503,
                errorBody("unavailable", "Photo storage is unavailable; try again."),
            );
    }
}

/** The file field named `photo`, else the first file field, in form order. */
function firstFile(form: FormData): File | undefined {
    const named = form.get("photo");
    if (named !== null) {
        const decoded = Option.getOrUndefined(decodeUploadFile(named));
        if (decoded !== undefined) return decoded;
    }
    for (const value of form.values()) {
        const decoded = Option.getOrUndefined(decodeUploadFile(value));
        if (decoded !== undefined) return decoded;
    }
    return undefined;
}

/**
 * The upload bytes as a stream. Multipart bodies are decoded so `curl -F` and
 * Shortcuts that post a form both work; anything else is read as the raw body.
 * The multipart parser buffers what it is handed, so the request is capped on
 * its real byte stream before `formData()` reads it — a missing or lying
 * `Content-Length` never widens the ceiling. The file's own bytes are capped
 * downstream as well, on the stream that reaches storage.
 */
function readUploadBody(
    request: Request,
): Effect.Effect<Uint8Array | ReadableStream<Uint8Array>, UploadError> {
    const contentType = request.headers.get("content-type") ?? "";
    if (!contentType.startsWith("multipart/form-data")) {
        return Effect.succeed(request.body ?? new Uint8Array());
    }

    const bounded = capRequestBody(request, MAX_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES);
    return Effect.gen(function* () {
        const form = yield* Effect.tryPromise({
            try: () => bounded.formData(),
            catch: (cause) =>
                new UploadError({ reason: isBodyTooLarge(cause) ? "TooLarge" : "InvalidImage" }),
        });
        const file = firstFile(form);
        if (file === undefined) return yield* new UploadError({ reason: "InvalidImage" });
        return file.stream();
    });
}

/** Authorize, validate the tag, read the body, store it. */
function uploadRoute(request: Request): Effect.Effect<Response, never, UploadService> {
    return Effect.gen(function* () {
        const token = Redacted.make(env.CONTENT_WRITER_TOKEN ?? "");
        if (!isAuthorized(request, token)) {
            return jsonResponse(
                401,
                errorBody("unauthorized", "A valid bearer token is required."),
            );
        }

        const declared = Number(request.headers.get("content-length") ?? "0");
        if (declared > MAX_UPLOAD_BYTES + MULTIPART_FRAMING_BYTES) {
            return uploadFailureResponse(new UploadError({ reason: "TooLarge" }));
        }

        const requested = new URL(request.url).searchParams.get("tag") ?? "cats";
        if (!isPhotoTag(requested)) {
            return jsonResponse(400, errorBody("invalid_tag", 'tag must be "cats" or "life".'));
        }

        const uploads = yield* UploadService;
        const body = yield* readUploadBody(request);
        const stored = yield* uploads.upload(requested, body);
        return jsonResponse(201, stored);
    }).pipe(
        Effect.catchTag("Upload.Error", (error) => Effect.succeed(uploadFailureResponse(error))),
    );
}

export const Route = createFileRoute("/api/photos")({
    server: {
        handlers: {
            POST: ({ request }) => runServer(uploadRoute(request)),
            GET: () =>
                jsonResponse(405, errorBody("method_not_allowed", "Upload with POST."), {
                    allow: "POST",
                }),
        },
    },
});
