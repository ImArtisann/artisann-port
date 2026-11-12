import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

export class HttpRequestFailure extends Schema.TaggedError<HttpRequestFailure>()(
    "HttpRequestFailure",
    {
        status: Schema.Int,
        code: Schema.Literals(["InvalidBody", "BodyTooLarge", "BodyTimeout", "InvalidRequest"]),
    },
) {}

export const readRequestBody = Effect.fn("Portfolio.readRequestBody")(function* (
    request: Request,
    maximum: number,
) {
    const stream = request.body;
    if (stream === null) return new Uint8Array();
    return yield* Stream.fromReadableStream({
        evaluate: () => stream,
        onError: () => new HttpRequestFailure({ status: 400, code: "InvalidBody" }),
    }).pipe(
        Stream.mapAccumEffect(
            () => 0,
            (size, bytes: Uint8Array) => {
                const next = size + bytes.byteLength;
                return next > maximum
                    ? Effect.fail(new HttpRequestFailure({ status: 413, code: "BodyTooLarge" }))
                    : Effect.succeed([next, [bytes]] as const);
            },
        ),
        Stream.runCollect,
        Effect.map((chunks) => {
            const total = chunks.reduce((size, bytes) => size + bytes.byteLength, 0);
            const body = new Uint8Array(total);
            let offset = 0;
            for (const bytes of chunks) {
                body.set(bytes, offset);
                offset += bytes.byteLength;
            }
            return body;
        }),
        Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.fail(new HttpRequestFailure({ status: 408, code: "BodyTimeout" })),
        }),
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
