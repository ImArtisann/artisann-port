/**
 * The upload body guard. `Request.formData()` buffers whatever it is handed,
 * so the byte ceiling has to sit on the request's real body stream, under the
 * parser: a missing or lying `Content-Length` must not let an unbounded body
 * reach the multipart parser, and the moment the ceiling is crossed the source
 * must stop being pulled.
 *
 * These tests exist because the cap used to be applied after `formData()` had
 * already buffered the whole body, which is exactly the bypass this closes.
 */
import { describe, expect, it } from "vite-plus/test";
import { capRequestBody, isBodyTooLarge } from "../src/server/body-limit.ts";

const UPLOAD_URL = "https://jakes.cat/api/photos";
const BOUNDARY = "----jakes-cats-boundary";

interface MultipartField {
    readonly name: string;
    readonly bytes: Uint8Array;
    readonly filename?: string;
}

/** One multipart part per field, framed the way a browser or Shortcut would. */
function multipartBytes(fields: ReadonlyArray<MultipartField>): Uint8Array {
    const encoder = new TextEncoder();
    const chunks: Array<Uint8Array> = [];
    for (const field of fields) {
        const disposition =
            field.filename === undefined
                ? `Content-Disposition: form-data; name="${field.name}"\r\n\r\n`
                : `Content-Disposition: form-data; name="${field.name}"; ` +
                  `filename="${field.filename}"\r\n` +
                  "Content-Type: application/octet-stream\r\n\r\n";
        chunks.push(
            encoder.encode(`--${BOUNDARY}\r\n${disposition}`),
            field.bytes,
            encoder.encode("\r\n"),
        );
    }
    chunks.push(encoder.encode(`--${BOUNDARY}--\r\n`));

    let length = 0;
    for (const chunk of chunks) length += chunk.byteLength;
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return body;
}

/**
 * A pull-based body: it yields a slice only when the consumer asks, and records
 * both how far it was pulled and whether it was canceled. A guard that buffers
 * the whole body first leaves both numbers at their maximum.
 */
function chunkedBody(bytes: Uint8Array, chunkSize: number) {
    let produced = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (produced >= bytes.byteLength) {
                controller.close();
                return;
            }
            const end = Math.min(produced + chunkSize, bytes.byteLength);
            controller.enqueue(bytes.subarray(produced, end));
            produced = end;
        },
        cancel() {
            cancelled = true;
        },
    });
    return { stream, produced: () => produced, cancelled: () => cancelled };
}

type Body = ReadableStream<Uint8Array>;

/** A POST whose body is a stream, with only the headers a client chose. */
function postRequest(body: Body, headers?: Record<string, string>): Request {
    const init: RequestInit & { readonly duplex?: "half" } = {
        method: "POST",
        body,
        duplex: "half",
    };
    if (headers !== undefined) init.headers = headers;
    return new Request(UPLOAD_URL, init);
}

/** The rejection `formData()` surfaced, which is where the guard's error rides. */
async function formDataFailure(request: Request): Promise<Error> {
    try {
        await request.formData();
    } catch (cause) {
        // SAFETY: `formData()` either parses or rejects; this branch is only
        // reached on rejection, and `isBodyTooLarge` walks the chain by
        // `instanceof` before any member is read.
        return cause as Error;
    }
    throw new Error("Expected formData() to reject.");
}

/** The rejection the guarded body stream surfaced, with no parser in between. */
async function bodyFailure(request: Request): Promise<Error> {
    try {
        await new Response(request.body).arrayBuffer();
    } catch (cause) {
        // SAFETY: the body either drains or rejects; this branch is only
        // reached on rejection, and `isBodyTooLarge` walks the chain by
        // `instanceof` before any member is read.
        return cause as Error;
    }
    throw new Error("Expected the body to reject.");
}

const multipartHeaders = () => ({
    "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
});

describe("capRequestBody", () => {
    it("rejects an oversized multipart body that declares no Content-Length", async () => {
        const chunkSize = 8 * 1024;
        const ceiling = 16 * 1024;
        const file = new Uint8Array(8 * chunkSize).fill(0x41);
        const body = multipartBytes([{ name: "photo", filename: "cat.jpg", bytes: file }]);
        const source = chunkedBody(body, chunkSize);
        const unlimited = postRequest(source.stream, multipartHeaders());

        const failure = await formDataFailure(capRequestBody(unlimited, ceiling));

        expect(isBodyTooLarge(failure)).toBe(true);
        // The parser never saw the whole body: the source was canceled, and
        // what it pulled stayed within the ceiling plus the pipe's own buffer,
        // nowhere near the body the client was streaming.
        expect(source.cancelled()).toBe(true);
        expect(source.produced()).toBeLessThanOrEqual(ceiling + 2 * chunkSize);
        expect(source.produced()).toBeLessThan(body.byteLength);
    });

    it("rejects when the oversized bytes ride an ignored form field", async () => {
        const body = multipartBytes([
            { name: "note", bytes: new Uint8Array(64 * 1024).fill(0x42) },
            { name: "photo", filename: "cat.jpg", bytes: new Uint8Array([1, 2, 3]) },
        ]);
        const source = chunkedBody(body, 8 * 1024);

        const failure = await formDataFailure(
            capRequestBody(postRequest(source.stream, multipartHeaders()), 16 * 1024),
        );

        expect(isBodyTooLarge(failure)).toBe(true);
        expect(source.produced()).toBeLessThan(body.byteLength);
    });

    it("rejects when the declared length denies the bytes that arrive", async () => {
        const body = multipartBytes([
            { name: "photo", filename: "cat.jpg", bytes: new Uint8Array(64 * 1024).fill(0x43) },
        ]);
        const source = chunkedBody(body, 8 * 1024);
        const lying = postRequest(source.stream, {
            ...multipartHeaders(),
            "content-length": "1",
        });

        const failure = await formDataFailure(capRequestBody(lying, 16 * 1024));

        expect(isBodyTooLarge(failure)).toBe(true);
        expect(source.produced()).toBeLessThan(body.byteLength);
    });

    it("parses a multipart body inside the ceiling", async () => {
        const file = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50]);
        const body = multipartBytes([{ name: "photo", filename: "cat.jpg", bytes: file }]);

        const form = await capRequestBody(
            postRequest(chunkedBody(body, 16).stream, multipartHeaders()),
            64 * 1024,
        ).formData();

        const field = form.get("photo");
        if (!(field instanceof File)) throw new Error("Expected a file field.");
        expect(new Uint8Array(await field.arrayBuffer())).toEqual(file);
    });

    it("lets a body exactly at the ceiling through and rejects one byte more", async () => {
        const body = new Uint8Array(16).fill(0x44);
        const headers = { "content-type": "application/octet-stream" };
        const atCeiling = await new Response(
            capRequestBody(postRequest(chunkedBody(body, 4).stream, headers), 16).body,
        ).arrayBuffer();
        expect(new Uint8Array(atCeiling)).toEqual(body);

        const overCeiling = chunkedBody(body, 4);
        const failure = await bodyFailure(
            capRequestBody(postRequest(overCeiling.stream, headers), 15),
        );
        expect(isBodyTooLarge(failure)).toBe(true);
    });

    it("reports a malformed body as a parse failure, not a size failure", async () => {
        const garbage = new TextEncoder().encode("this is not multipart at all");
        const request = postRequest(chunkedBody(garbage, 8).stream, multipartHeaders());

        const failure = await formDataFailure(capRequestBody(request, 64 * 1024));

        expect(isBodyTooLarge(failure)).toBe(false);
    });
});
