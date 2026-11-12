import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class HttpRequestFailure extends Schema.TaggedError<HttpRequestFailure>()(
    "HttpRequestFailure",
    {
        status: Schema.Int,
        code: Schema.Literals(["InvalidBody", "BodyTooLarge", "BodyTimeout", "InvalidRequest"]),
    },
) {}

/** Longest wait for the next chunk; a stalled client fails fast however large its body. */
const BODY_IDLE_TIMEOUT = Duration.seconds(5);
/** Slowest sustained rate a body may arrive at; sets the total deadline per route maximum. */
const MIN_BODY_BYTES_PER_SECOND = 256 * 1024;
/** First allocation when the client sends no usable `content-length`. */
const UNKNOWN_LENGTH_INITIAL_BYTES = 64 * 1024;

const tooLarge = () => new HttpRequestFailure({ status: 413, code: "BodyTooLarge" });
const timedOut = () => Effect.fail(new HttpRequestFailure({ status: 408, code: "BodyTimeout" }));

/**
 * Read at most `maximum` bytes into one buffer. A declared length sizes that
 * buffer up front, so a photo upload holds a single copy instead of its chunks
 * plus their concatenation; the actual byte count still decides the limit.
 */
export const readRequestBody = Effect.fn("Portfolio.readRequestBody")(function* (
    request: Request,
    maximum: number,
) {
    const stream = request.body;
    if (stream === null) return new Uint8Array();
    const header = request.headers.get("content-length");
    const declared = header !== null && /^\d{1,15}$/u.test(header) ? Number(header) : null;
    if (declared !== null && declared > maximum) return yield* tooLarge();
    const deadline = Duration.sum(
        BODY_IDLE_TIMEOUT,
        Duration.seconds(maximum / MIN_BODY_BYTES_PER_SECOND),
    );
    return yield* Effect.acquireUseRelease(
        Effect.sync(() => stream.getReader()),
        (reader) =>
            Effect.gen(function* () {
                let body = new Uint8Array(
                    Math.min(maximum, declared ?? UNKNOWN_LENGTH_INITIAL_BYTES),
                );
                let size = 0;
                for (;;) {
                    const chunk = yield* Effect.tryPromise({
                        try: () => reader.read(),
                        catch: () => new HttpRequestFailure({ status: 400, code: "InvalidBody" }),
                    }).pipe(
                        Effect.timeoutOrElse({ duration: BODY_IDLE_TIMEOUT, orElse: timedOut }),
                    );
                    if (chunk.done) return body.subarray(0, size);
                    const next = size + chunk.value.byteLength;
                    if (next > maximum) return yield* tooLarge();
                    if (next > body.byteLength) {
                        const grown = new Uint8Array(
                            Math.min(maximum, Math.max(next, body.byteLength * 2)),
                        );
                        grown.set(body.subarray(0, size));
                        body = grown;
                    }
                    body.set(chunk.value, size);
                    size = next;
                }
            }).pipe(Effect.timeoutOrElse({ duration: deadline, orElse: timedOut })),
        // Stops an unfinished upload; cancelling a drained or errored stream has nothing to report.
        (reader) => Effect.tryPromise(() => reader.cancel()).pipe(Effect.ignore),
    );
});

export const readJsonRequest = <A, I>(
    request: Request,
    schema: Schema.Codec<A, I>,
    maximum: number,
) =>
    Effect.gen(function* () {
        const bytes = yield* readRequestBody(request, maximum);
        const text = yield* Effect.try({
            try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
            catch: () => new HttpRequestFailure({ status: 400, code: "InvalidBody" }),
        });
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
            Effect.mapError(() => new HttpRequestFailure({ status: 400, code: "InvalidBody" })),
        );
    });
