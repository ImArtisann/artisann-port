import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { decodeHTMLAttribute } from "entities/decode";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type { HttpClientResponse } from "effect/unstable/http/HttpClientResponse";
import type { DeployedApp, SiteContent } from "./content.ts";
import { isPublicDnsHostname } from "./project-hosts.ts";
import { projectPreviewUrl } from "./projects.ts";

/** The subset of Cloudflare's Cache API used by project previews. */
export interface ProjectImageCache {
    match(request: Request): Promise<Pick<Response, "body" | "headers" | "status"> | undefined>;
    // Bun adds constructor-only Response methods that standard clone results do not have.
    put(request: Request, response: ReturnType<Response["clone"]>): Promise<void>;
}

class PreviewError extends Schema.TaggedError<PreviewError>()("PreviewError", {
    message: Schema.String,
}) {}

function allowedUrl(value: string, base: string, hosts: readonly string[]): URL {
    const url = new URL(value, base);
    if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.port ||
        !isPublicDnsHostname(url.hostname) ||
        !hosts.includes(url.hostname)
    ) {
        throw new PreviewError({ message: "Project preview URL is outside its approved hosts" });
    }
    url.hash = "";
    return url;
}

const fetchAllowed = Effect.fn("ProjectPreview.fetch")(function* (
    initial: string,
    hosts: readonly string[],
) {
    let url = initial;
    for (let redirects = 0; redirects <= 3; redirects++) {
        const checked = yield* Effect.try({
            try: () => allowedUrl(url, initial, hosts),
            catch: () => new PreviewError({ message: "Unsafe project preview URL" }),
        });
        const response = yield* HttpClient.get(checked.href);
        const location = response.headers.location;
        if (response.status >= 300 && response.status < 400 && location) {
            url = yield* Effect.try({
                try: () => new URL(location, checked).href,
                catch: () => new PreviewError({ message: "Unsafe project preview redirect" }),
            });
            continue;
        }
        if (response.status !== 200) {
            return yield* new PreviewError({
                message: `Project preview upstream returned ${response.status}`,
            });
        }
        return { response, url: checked.href };
    }
    return yield* new PreviewError({ message: "Too many project preview redirects" });
});

const readBounded = Effect.fn("ProjectPreview.readBody")(function* (
    response: HttpClientResponse,
    maximum: number,
) {
    let length = 0;
    const chunks = yield* Stream.runCollect(
        response.stream.pipe(
            Stream.tap((chunk) => {
                length += chunk.byteLength;
                return length > maximum
                    ? Effect.fail(
                          new PreviewError({ message: "Project preview response is too large" }),
                      )
                    : Effect.void;
            }),
        ),
    );
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
});

/** HTMLRewriter preserves raw attribute entities; decode them before resolving the URL. */
export const extractOpenGraphImage = Effect.fn("ProjectPreview.parseHtml")(function* (
    html: Uint8Array<ArrayBuffer>,
) {
    let image: string | null = null;
    let secureImage: string | null = null;
    yield* Effect.tryPromise({
        try: () =>
            new HTMLRewriter()
                .on("meta", {
                    element(element) {
                        const property = element.getAttribute("property")?.toLowerCase();
                        const content = element.getAttribute("content")?.trim();
                        if (!content) return;
                        if (property === "og:image" && image === null) image = content;
                        if (property === "og:image:secure_url" && secureImage === null)
                            secureImage = content;
                    },
                })
                .transform(new Response(html))
                .arrayBuffer(),
        catch: () => new PreviewError({ message: "Could not parse project Open Graph metadata" }),
    });
    const result = secureImage ?? image;
    if (result === null)
        return yield* new PreviewError({ message: "Project has no Open Graph image" });
    return decodeHTMLAttribute(result);
});

const downloadPreview = Effect.fn("ProjectPreview.download")(function* (app: DeployedApp) {
    const page = yield* Effect.try({
        try: () => {
            const pageUrl = new URL(app.url);
            if (!isPublicDnsHostname(pageUrl.hostname)) {
                throw new Error("Project page is not a public DNS hostname");
            }
            const pageHosts = pageUrl.hostname.startsWith("www.")
                ? [pageUrl.hostname, pageUrl.hostname.slice(4)]
                : [pageUrl.hostname, `www.${pageUrl.hostname}`];
            return { url: pageUrl.href, hosts: pageHosts };
        },
        catch: () => new PreviewError({ message: "Unsafe project page URL" }),
    });
    const pageResponse = yield* fetchAllowed(page.url, page.hosts);
    if (!pageResponse.response.headers["content-type"]?.includes("text/html")) {
        return yield* new PreviewError({ message: "Project did not return HTML" });
    }
    const html = yield* readBounded(pageResponse.response, 1_048_576);
    const imageReference = yield* extractOpenGraphImage(html);
    const imageHosts = [...new Set([...page.hosts, ...app.ogImageHosts])];
    const imageUrl = yield* Effect.try({
        try: () => allowedUrl(imageReference, pageResponse.url, imageHosts).href,
        catch: () => new PreviewError({ message: "Unsafe Open Graph image URL" }),
    });
    const image = yield* fetchAllowed(imageUrl, imageHosts);
    const contentType = image.response.headers["content-type"]?.split(";")[0]?.trim();
    if (
        !contentType ||
        !["image/png", "image/jpeg", "image/webp", "image/avif", "image/gif"].includes(contentType)
    ) {
        return yield* new PreviewError({
            message: "Open Graph URL did not return a supported image",
        });
    }
    const bytes = yield* readBounded(image.response, 5_242_880);
    return new Response(bytes, {
        headers: {
            "content-type": contentType,
            "content-length": String(bytes.byteLength),
            "cache-control": "public, max-age=86400",
            "x-content-type-options": "nosniff",
            "access-control-allow-origin": "*",
        },
    });
});

export const projectPreviewResponse = Effect.fn("ProjectPreview.respond")(function* (
    request: Request,
    cache: ProjectImageCache,
    content: SiteContent,
) {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
    }
    const path = new URL(request.url).pathname;
    const app = content.apps.find((candidate) => path === `/projects/${candidate.id}/og-image`);
    if (!app) return new Response(null, { status: 404 });
    // Ignore arbitrary query parameters and request headers when choosing a cache key.
    const key = new Request(projectPreviewUrl(app));
    const existing = yield* Effect.tryPromise(() => cache.match(key));
    const response =
        existing ??
        (yield* downloadPreview(app).pipe(
            Effect.timeout("20 seconds"),
            Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.tap((image) => Effect.tryPromise(() => cache.put(key, image.clone()))),
        ));
    const headers = new Headers(response.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("x-preview-cache", existing ? "HIT" : "MISS");
    return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers,
    });
});
