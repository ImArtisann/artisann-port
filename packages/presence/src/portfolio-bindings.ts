import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { CmsBindings } from "./cms-service.ts";
import { CONTENT_WRITER_OBJECT_NAME } from "./content-writer.ts";
import type {
    ContentMigrationBinding,
    ContentMigrationSource,
} from "./content-migration-source.ts";
import { GithubBinding } from "./github.ts";
import { NotesConfig, NotesRateLimit, type NotesWorkerEnv } from "./notes-service.ts";
import { PhotosBinding, PhotosConfig, type PhotosR2MutationBinding } from "./photos-service.ts";
import {
    PresenceBinding,
    PRESENCE_OBJECT_NAME,
    type PresenceNamespace,
} from "./presence-service.ts";
import type { PresenceKvBinding } from "./store.ts";

export interface PortfolioWorkerEnvironment extends NotesWorkerEnv {
    readonly PRESENCE_KV: PresenceKvBinding;
    readonly PHOTOS: PhotosR2MutationBinding;
    readonly ASSETS_HOST: string;
    readonly CONTENT_WRITER: ContentMigrationBinding;
    readonly PRESENCE: PresenceNamespace;
    readonly CONTENT_WRITER_TOKEN: string;
}
export class PortfolioEnvironment extends Context.Service<
    PortfolioEnvironment,
    PortfolioWorkerEnvironment
>()("Portfolio/Environment") {}

export const NativePortfolioBindingsLive = Layer.effectContext(
    Effect.gen(function* () {
        const native = yield* Cloudflare.WorkerEnvironment;
        // SAFETY: the stack declares these native bindings and runtime-only strings for this Worker.
        const env = native as PortfolioWorkerEnvironment;
        const source = (): ContentMigrationSource =>
            env.CONTENT_WRITER.get(env.CONTENT_WRITER.idFromName(CONTENT_WRITER_OBJECT_NAME));
        const writer: ContentMigrationSource = {
            getState: () => source().getState(),
            apply: (action) => source().apply(action),
            migrationPrepare: (epoch) => source().migrationPrepare(epoch),
            migrationStatus: () => source().migrationStatus(),
            migrationBaseline: () => source().migrationBaseline(),
            migrationEntries: (after, take) => source().migrationEntries(after, take),
            migrationDecisions: (after, take) => source().migrationDecisions(after, take),
            migrationFence: (epoch, sequence) => source().migrationFence(epoch, sequence),
            migrationComplete: (epoch, sequence) => source().migrationComplete(epoch, sequence),
        };
        return Context.make(PortfolioEnvironment, env).pipe(
            Context.add(CmsBindings, { snapshots: env.PRESENCE_KV, writer }),
            Context.add(PhotosBinding, env.PHOTOS),
            Context.add(PhotosConfig, { assetsHost: env.ASSETS_HOST }),
            Context.add(GithubBinding, env.PRESENCE_KV),
            Context.add(PresenceBinding, {
                getSnapshot: () =>
                    env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_OBJECT_NAME)).getSnapshot(),
                publishSnapshot: (value) =>
                    env.PRESENCE.get(env.PRESENCE.idFromName(PRESENCE_OBJECT_NAME)).publishSnapshot(
                        value,
                    ),
            }),
            Context.add(NotesRateLimit, { binding: env.NOTES_RATE_LIMIT }),
            Context.add(NotesConfig, {
                websiteOrigin: env.WEBSITE_ORIGIN,
                discordNotesChannelId: env.DISCORD_NOTES_CHANNEL_ID,
                discordNotesWebhookUrl: Redacted.make(env.DISCORD_NOTES_WEBHOOK_URL),
                turnstileSecretKey: Redacted.make(env.TURNSTILE_SECRET_KEY),
            }),
        );
    }),
);
