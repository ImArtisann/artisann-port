import type { D1Database, ImagesBinding, R2Bucket } from "@cloudflare/workers-types";
import type { PhotosR2Binding } from "@artisann-port/presence/photos";

export type PhotosR2ReadBinding = PhotosR2Binding & Pick<R2Bucket, "head">;
export interface VisitorRateLimitBinding {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}
export interface CatsWorkerEnv {
    readonly LIKES: D1Database;
    readonly IMAGES: ImagesBinding;
    readonly PHOTOS: PhotosR2ReadBinding;
    readonly VISITOR_RATE_LIMIT: VisitorRateLimitBinding;
    readonly CONTENT_WRITER_TOKEN: string;
    readonly ASSETS_HOST: string;
    readonly PORTFOLIO_ORIGIN: string;
}
