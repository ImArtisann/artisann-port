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
import { ASSET_CACHE_CONTROL, DEFAULT_ASSETS_BUCKET_NAME } from "../src/config.ts";
import { collectAssets, hashedKey } from "../src/sources.ts";

const CONCURRENCY = 8;

/**
 * Object-level R2 access. `head` answers "does this key already hold bytes",
 * which is all a content-addressed upload needs to stay idempotent.
 */
interface Transport {
    readonly name: string;
    head(key: string): Promise<Response>;
    put(key: string, data: Uint8Array, contentType: string): Promise<Response>;
}

function encodeKey(key: string): string {
    return key.split("/").map(encodeURIComponent).join("/");
}

function s3Transport(bucketName: string): Transport | undefined {
    const accountId = process.env.R2_ACCOUNT_ID ?? "";
    const accessKeyId = process.env.R2_ACCESS_KEY_ID ?? "";
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY ?? "";
    if (accountId === "" || accessKeyId === "" || secretAccessKey === "") return undefined;

    const client = new AwsClient({ service: "s3", region: "auto", accessKeyId, secretAccessKey });
    const base = `https://${accountId}.r2.cloudflarestorage.com/${bucketName}`;
    return {
        name: "R2 S3 API",
        head: (key) => client.fetch(`${base}/${encodeKey(key)}`, { method: "HEAD" }),
        put: (key, data, contentType) =>
            client.fetch(`${base}/${encodeKey(key)}`, {
                method: "PUT",
                headers: { "content-type": contentType, "cache-control": ASSET_CACHE_CONTROL },
                body: data,
            }),
    };
}

function cloudflareTransport(bucketName: string): Transport | undefined {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? "";
    if (accountId === "" || apiToken === "") return undefined;

    const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/objects`;
    const authorization = `Bearer ${apiToken}`;
    return {
        name: "Cloudflare REST API",
        // The REST endpoint rejects HEAD with 405, so existence is probed with a
        // ranged GET; only the status is read, never the body.
        head: (key) =>
            fetch(`${base}/${encodeKey(key)}`, {
                method: "GET",
                headers: { authorization, range: "bytes=0-0" },
            }),
        put: (key, data, contentType) =>
            fetch(`${base}/${encodeKey(key)}`, {
                method: "PUT",
                headers: {
                    authorization,
                    "content-type": contentType,
                    "cache-control": ASSET_CACHE_CONTROL,
                },
                body: data,
            }),
    };
}

const assets = await collectAssets();
if (assets.length === 0) {
    console.log("images/ is empty, nothing to upload");
    process.exit(0);
}

const bucketName = process.env.ASSETS_BUCKET_NAME ?? DEFAULT_ASSETS_BUCKET_NAME;

if (process.argv.includes("--plan")) {
    for (const asset of assets) {
        console.log(`PUT ${asset.key} (${asset.contentType}, ${asset.bytes} bytes)`);
    }
    console.log(`${assets.length} object(s) planned for ${bucketName}`);
    process.exit(0);
}

const transport = s3Transport(bucketName) ?? cloudflareTransport(bucketName);
if (transport === undefined) {
    throw new Error(
        "No R2 credentials: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, " +
            "or CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN.",
    );
}

let nextIndex = 0;
let uploaded = 0;
let skipped = 0;
let uploadedBytes = 0;

const workers = Array.from({ length: Math.min(CONCURRENCY, assets.length) }, async () => {
    while (true) {
        const asset = assets[nextIndex++];
        if (asset === undefined) return;

        const existing = await transport.head(asset.key);
        if (existing.ok) {
            await existing.body?.cancel();
            skipped += 1;
            continue;
        }
        if (existing.status !== 404) {
            throw new Error(
                `HEAD ${asset.key} failed with ${existing.status}: ${await existing.text()}`,
            );
        }
        await existing.body?.cancel();

        const data = await Bun.file(asset.file).bytes();
        if (hashedKey(asset.path, data) !== asset.key) {
            throw new Error(`Image ${asset.path} changed during upload; run the command again.`);
        }
        const response = await transport.put(asset.key, data, asset.contentType);
        if (!response.ok) {
            throw new Error(
                `PUT ${asset.key} failed with ${response.status}: ${await response.text()}`,
            );
        }
        await response.body?.cancel();
        uploaded += 1;
        uploadedBytes += asset.bytes;
    }
});

await Promise.all(workers);
console.log(
    `uploaded ${uploaded}, skipped ${skipped}, bytes ${uploadedBytes} ` +
        `(${bucketName} via ${transport.name})`,
);
