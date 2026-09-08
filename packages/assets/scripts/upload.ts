/**
 * Uploads every image under `images/` to the R2 bucket over the S3 API.
 *
 *   bun run upload:plan   # list the objects that would be written, no credentials needed
 *   bun run upload        # write the missing objects
 *
 * Object keys are content-addressed, so an object that already exists is never
 * rewritten and re-running the script is a no-op. Credentials come from the
 * package's `.env` or the process environment.
 */
import { AwsClient } from "aws4fetch";
import { ASSET_CACHE_CONTROL, DEFAULT_ASSETS_BUCKET_NAME } from "../src/config.ts";
import { collectAssets, hashedKey } from "../src/sources.ts";

const CONCURRENCY = 8;

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

const credentials = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID ?? "",
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID ?? "",
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY ?? "",
};
const missing = Object.entries(credentials)
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);
if (missing.length > 0) {
    throw new Error(`Missing environment variables: ${missing.join(", ")}`);
}

const client = new AwsClient({
    service: "s3",
    region: "auto",
    accessKeyId: credentials.R2_ACCESS_KEY_ID,
    secretAccessKey: credentials.R2_SECRET_ACCESS_KEY,
});
const base = `https://${credentials.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${bucketName}`;

let nextIndex = 0;
let uploaded = 0;
let skipped = 0;
let uploadedBytes = 0;

const workers = Array.from({ length: Math.min(CONCURRENCY, assets.length) }, async () => {
    while (true) {
        const asset = assets[nextIndex++];
        if (asset === undefined) return;

        const url = `${base}/${asset.key.split("/").map(encodeURIComponent).join("/")}`;
        const existing = await client.fetch(url, { method: "HEAD" });
        if (existing.status === 200) {
            skipped += 1;
            continue;
        }
        if (existing.status !== 404) {
            throw new Error(
                `HEAD ${asset.key} failed with ${existing.status}: ${await existing.text()}`,
            );
        }

        const data = await Bun.file(asset.file).bytes();
        if (hashedKey(asset.path, data) !== asset.key) {
            throw new Error(`Image ${asset.path} changed during upload; run the command again.`);
        }
        const response = await client.fetch(url, {
            method: "PUT",
            headers: { "content-type": asset.contentType, "cache-control": ASSET_CACHE_CONTROL },
            body: data,
        });
        if (!response.ok) {
            throw new Error(
                `PUT ${asset.key} failed with ${response.status}: ${await response.text()}`,
            );
        }
        uploaded += 1;
        uploadedBytes += asset.bytes;
    }
});

await Promise.all(workers);
console.log(`uploaded ${uploaded}, skipped ${skipped}, bytes ${uploadedBytes}`);
