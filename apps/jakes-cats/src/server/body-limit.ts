/**
 * A hard byte ceiling on a request body, enforced on the stream itself so a
 * missing or lying `Content-Length` cannot sneak an unbounded body past the
 * guard. `Request.formData()` buffers everything it is given, so the cap must
 * live underneath the parser, not after it.
 */
import * as Schema from "effect/Schema";

/** Raised inside the stream the moment the byte ceiling is crossed. */
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()("Body.TooLarge", {
    limit: Schema.Int,
}) {}

const isLimitError = Schema.is(BodyTooLarge);

/** Whether a thrown value is the cap tripping, possibly wrapped by a parser. */
export function isBodyTooLarge(cause: unknown): boolean {
    let current: unknown = cause;
    while (current instanceof Error) {
        if (isLimitError(current)) return true;
        current = current.cause;
    }
    return false;
}

/**
 * The same request, but its body errors with `BodyTooLarge` once more than
 * `limit` bytes have actually arrived. When the readable side errors,
 * `pipeThrough` cancels the source reader, so the client stops uploading
 * instead of streaming an unbounded body into the parser. A request with no
 * body is returned unchanged.
 */
export function capRequestBody(request: Request, limit: number): Request {
    const body = request.body;
    if (body === null) return request;

    let received = 0;
    let tripped = false;
    const capped = body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
                if (tripped) return;
                received += chunk.byteLength;
                if (received > limit) {
                    tripped = true;
                    controller.error(new BodyTooLarge({ limit }));
                    return;
                }
                controller.enqueue(chunk);
            },
        }),
    );

    const init: RequestInit & { readonly duplex: "half" } = { body: capped, duplex: "half" };
    return new Request(request, init);
}
