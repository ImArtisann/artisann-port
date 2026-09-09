import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcMiddleware from "effect/unstable/rpc/RpcMiddleware";
import {
    ApiUnavailable,
    ContentWriteError,
    NoteSubmissionError,
    PhotoWriteError,
    WriterUnauthorized,
} from "./api-errors.ts";
import { SiteContent } from "./content.ts";
import { ContentWriterAction, ContentWriterResult, ContentWriterState } from "./content-writer.ts";
import { GithubSnapshot } from "./github-schema.ts";
import { NoteSubmissionAccepted, RawNoteSubmission } from "./notes.ts";
import { PhotoPage, PhotoTag } from "./photos.ts";
import { PresenceSnapshot } from "./schema.ts";

export const WeatherReading = Schema.Struct({
    temperature: Schema.Finite,
    unit: Schema.NonEmptyString,
});
export type WeatherReading = typeof WeatherReading.Type;

export class WriterAuth extends RpcMiddleware.Service<WriterAuth>()("WriterAuth", {
    error: WriterUnauthorized,
}) {}

export const PublicRpcs = RpcGroup.make(
    Rpc.make("content.get", { payload: {}, success: SiteContent, error: ApiUnavailable }),
    Rpc.make("photos.list", {
        payload: {
            tag: PhotoTag,
            cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
        },
        success: PhotoPage,
        error: ApiUnavailable,
    }),
    Rpc.make("github.get", { payload: {}, success: GithubSnapshot, error: ApiUnavailable }),
    Rpc.make("weather.get", { payload: {}, success: WeatherReading, error: ApiUnavailable }),
);

export const WriterRpcs = RpcGroup.make(
    Rpc.make("presence.get", { payload: {}, success: PresenceSnapshot, error: ApiUnavailable }),
    Rpc.make("presence.publish", {
        payload: { snapshot: PresenceSnapshot },
        success: PresenceSnapshot,
        error: ApiUnavailable,
    }),
    Rpc.make("content.state", { payload: {}, success: ContentWriterState, error: ApiUnavailable }),
    Rpc.make("content.apply", {
        payload: ContentWriterAction,
        success: ContentWriterResult,
        error: Schema.Union([ContentWriteError, ApiUnavailable]),
    }),
    Rpc.make("photos.upload", {
        payload: { tag: PhotoTag, interactionId: Schema.String, bytes: Schema.Uint8Array },
        success: Schema.String,
        error: Schema.Union([PhotoWriteError, ApiUnavailable]),
    }),
    Rpc.make("photos.delete", {
        payload: { tag: PhotoTag, photoId: Schema.String },
        success: Schema.Void,
        error: Schema.Union([PhotoWriteError, ApiUnavailable]),
    }),
).middleware(WriterAuth);

export const NotesRpcs = RpcGroup.make(
    Rpc.make("notes.submit", {
        payload: RawNoteSubmission.annotate({ parseOptions: { onExcessProperty: "error" } }),
        success: NoteSubmissionAccepted,
        error: NoteSubmissionError,
    }),
);
