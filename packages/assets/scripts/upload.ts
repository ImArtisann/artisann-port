/**
 * Uploads every image under `images/` to the R2 bucket.
 *
 *   bun run upload:plan   # list the objects that would be written, no credentials needed
 *   bun run upload        # write the missing objects
 *
 * Object keys are content-addressed, so an object that already exists is never
 * rewritten and re-running the script is a no-op. Credentials come from the
 * package's `.env` or the process environment, over whichever transport is
 * configured:
 *
 *   - S3 API (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) —
 *     preferred for CI, since an R2 access key is scoped to object storage.
 *   - Cloudflare REST API (`CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`) —
 *     reuses the same account token the Alchemy stacks deploy with, so no
 *     second credential has to exist for a local upload.
 */
import { AwsClient } from "aws4fetch";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ASSET_CACHE_CONTROL, DEFAULT_ASSETS_BUCKET_NAME } from "../src/config.ts";
import { collectAssets, hashedKey, type CollectedAsset } from "../src/sources.ts";

const CONCURRENCY = 8;

class UploadError extends Schema.TaggedError<UploadError>()("UploadError", {
    message: Schema.String,
}) {}

/**
 * Object-level R2 access. `head` answers "does this key already hold bytes",
 * which is all a content-addressed upload needs to stay idempotent.
 */
interface Transport {
    readonly name: string;
    readonly head: (
        key: string,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, UploadError, HttpClient.HttpClient>;
    readonly put: (
        key: string,
        data: Uint8Array,
        contentType: string,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, UploadError, HttpClient.HttpClient>;
}

/** Empty `.env` placeholders are absence, matching the previous `|| ""` checks. */
const optionalText = (name: string) =>
    Config.option(Config.string(name)).pipe(Config.map(Option.filter((value) => value.length > 0)));

const optionalSecret = (name: string) =>
    Config.option(Config.redacted(name)).pipe(
        Config.map(Option.filter((secret) => Redacted.value(secret).length > 0)),
    );

function encodeKey(key: string): string {
    return key.split("/").map(encodeURIComponent).join("/");
}

const execute = (request: HttpClientRequest.HttpClientRequest) =>
    HttpClient.execute(request).pipe(
        Effect.mapError((error) => new UploadError({ message: error.message })),
    );

const executeSigned = (client: AwsClient, request: HttpClientRequest.HttpClientRequest) =>
    HttpClientRequest.toWeb(request).pipe(
        Effect.mapError((error) => new UploadError({ message: error.message })),
        Effect.flatMap((webRequest) =>
            Effect.tryPromise({
                try: (signal) => client.fetch(webRequest, { signal }),
                catch: (cause) =>
                    new UploadError({
                        message: cause instanceof Error ? cause.message : String(cause),
                    }),
            }),
        ),
        Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    );

const discardBody = (response: HttpClientResponse.HttpClientResponse) =>
    Stream.runHead(response.stream).pipe(
        Effect.catchReason("HttpClientError", "EmptyBodyError", () => Effect.succeedNone),
        Effect.mapError((error) => new UploadError({ message: error.message })),
    );

const s3Transport = Effect.fn("Assets.s3Transport")(function* (bucketName: string) {
    const credentials = Option.all({
        accountId: yield* optionalText("R2_ACCOUNT_ID"),
        accessKeyId: yield* optionalText("R2_ACCESS_KEY_ID"),
        secretAccessKey: yield* optionalSecret("R2_SECRET_ACCESS_KEY"),
    });
    return Option.map(credentials, ({ accountId, accessKeyId, secretAccessKey }) => {
        const client = new AwsClient({
            service: "s3",
            region: "auto",
            accessKeyId,
            secretAccessKey: Redacted.value(secretAccessKey),
        });
        const base = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`;
        return {
            name: "R2 S3 API",
            head: (key) =>
                executeSigned(client, HttpClientRequest.head(`${base}/${encodeKey(key)}`)),
            put: (key, data, contentType) =>
                executeSigned(
                    client,
                    HttpClientRequest.put(`${base}/${encodeKey(key)}`).pipe(
                        HttpClientRequest.bodyUint8Array(data, contentType),
                        HttpClientRequest.setHeader("cache-control", ASSET_CACHE_CONTROL),
                    ),
                ),
        } satisfies Transport;
    });
});

const cloudflareTransport = Effect.fn("Assets.cloudflareTransport")(function* (bucketName: string) {
    const credentials = Option.all({
        accountId: yield* optionalText("CLOUDFLARE_ACCOUNT_ID"),
        apiToken: yield* optionalSecret("CLOUDFLARE_API_TOKEN"),
    });
    return Option.map(credentials, ({ accountId, apiToken }) => {
        const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`;
        const authorized = (request: HttpClientRequest.HttpClientRequest) =>
            execute(HttpClientRequest.bearerToken(request, apiToken));
        return {
            name: "Cloudflare REST API",
            // The REST endpoint rejects HEAD with 405, so existence is probed with a
            // ranged GET; only the status is read, never the body.
            head: (key) =>
                authorized(
                    HttpClientRequest.get(`${base}/${encodeKey(key)}`).pipe(
                        HttpClientRequest.setHeader("range", "bytes=0-0"),
                    ),
                ),
            put: (key, data, contentType) =>
                authorized(
                    HttpClientRequest.put(`${base}/${encodeKey(key)}`).pipe(
                        HttpClientRequest.bodyUint8Array(data, contentType),
                        HttpClientRequest.setHeader("cache-control", ASSET_CACHE_CONTROL),
                    ),
                ),
        } satisfies Transport;
    });
});

const resolveTransport = Effect.fn("Assets.resolveTransport")(function* (bucketName: string) {
    const s3 = yield* s3Transport(bucketName);
    if (Option.isSome(s3)) return s3.value;
    const cloudflare = yield* cloudflareTransport(bucketName);
    if (Option.isNone(cloudflare)) {
        return yield* new UploadError({
            message:
                "No R2 credentials: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, " +
                "or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
        });
    }
    return cloudflare.value;
});

const uploadOne = Effect.fn("Assets.uploadObject")(function* (
    transport: Transport,
    asset: CollectedAsset,
) {
    const existing = yield* transport.head(asset.key);
    if (existing.status >= 200 && existing.status < 300) {
        yield* discardBody(existing);
        return { uploaded: false, bytes: 0 } as const;
    }
    if (existing.status !== 404) {
        const body = yield* existing.text.pipe(
            Effect.mapError((error) => new UploadError({ message: error.message })),
        );
        return yield* new UploadError({
            message: `HEAD ${asset.key} failed with ${existing.status}: ${body}`,
        });
    }
    yield* discardBody(existing);

    const data = yield* Effect.tryPromise({
        try: () => Bun.file(asset.file).bytes(),
        catch: (cause) =>
            new UploadError({
                message: cause instanceof Error ? cause.message : String(cause),
            }),
    });
    if (hashedKey(asset.path, data) !== asset.key) {
        return yield* new UploadError({
            message: `Image ${asset.path} changed during upload; run the command again.`,
        });
    }
    const response = yield* transport.put(asset.key, data, asset.contentType);
    if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text.pipe(
            Effect.mapError((error) => new UploadError({ message: error.message })),
        );
        return yield* new UploadError({
            message: `PUT ${asset.key} failed with ${response.status}: ${body}`,
        });
    }
    yield* discardBody(response);
    return { uploaded: true, bytes: asset.bytes } as const;
});

const upload = Effect.gen(function* () {
    const assets = yield* collectAssets;
    if (assets.length === 0) {
        yield* Console.log("images/ is empty, nothing to upload");
        return;
    }

    const bucketName = yield* Config.nonEmptyString("ASSETS_BUCKET_NAME").pipe(
        Config.withDefault(DEFAULT_ASSETS_BUCKET_NAME),
    );

    if (process.argv.includes("--plan")) {
        yield* Effect.forEach(
            assets,
            (asset) => Console.log(`PUT ${asset.key} (${asset.contentType}, ${asset.bytes} bytes)`),
            { discard: true },
        );
        yield* Console.log(`${assets.length} object(s) planned for ${bucketName}`);
        return;
    }

    const transport = yield* resolveTransport(bucketName);
    const results = yield* Effect.forEach(assets, (asset) => uploadOne(transport, asset), {
        concurrency: CONCURRENCY,
    });
    let uploaded = 0;
    let skipped = 0;
    let uploadedBytes = 0;
    for (const result of results) {
        if (result.uploaded) {
            uploaded += 1;
            uploadedBytes += result.bytes;
        } else {
            skipped += 1;
        }
    }
    yield* Console.log(
        `uploaded ${uploaded}, skipped ${skipped}, bytes ${uploadedBytes} ` +
            `(${bucketName} via ${transport.name})`,
    );
});

await Effect.runPromise(
    upload.pipe(Effect.provide(Layer.mergeAll(Path.layer, FetchHttpClient.layer))),
);
