import * as cf from "cloudflare:workers";
import type { R2Bucket } from "@cloudflare/workers-types";
import type { PhotosR2Binding } from "@artisann-port/presence/photos";
import type { WebsiteEnv } from "../alchemy.run.ts";

/** The R2 surface this site drives: gallery listing plus upload, probe, and rollback. */
export type PhotosR2MutationBinding = PhotosR2Binding & Pick<R2Bucket, "put" | "head" | "delete">;

/** Cloudflare's simple edge rate limiter, as far as hearts and comments use it. */
export interface VisitorRateLimitBinding {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * The Worker's `env`: everything the stack declared plus the two rows attached
 * with `.bind(...)`, which `Cloudflare.InferEnv` cannot see.
 */
export type CatsWorkerEnv = WebsiteEnv & {
    readonly PHOTOS: PhotosR2MutationBinding;
    readonly VISITOR_RATE_LIMIT: VisitorRateLimitBinding;
};

export const env = new Proxy(
    // SAFETY: bindings arrive after module evaluation; reads forward to the live CatsWorkerEnv.
    {} as CatsWorkerEnv,
    {
        get(_target, property) {
            // SAFETY: CatsWorkerEnv keys are exactly the bindings declared in alchemy.run.ts.
            return cf.env[property as keyof typeof cf.env];
        },
    },
);
