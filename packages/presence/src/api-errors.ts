import * as Schema from "effect/Schema";
import { ContentWriterErrorKind } from "./content-writer.ts";

export class WriterUnauthorized extends Schema.TaggedError<WriterUnauthorized>()(
    "WriterUnauthorized",
    {},
) {}

export class ApiUnavailable extends Schema.TaggedError<ApiUnavailable>()("ApiUnavailable", {
    operation: Schema.String,
}) {}

export class ContentWriteError extends Schema.TaggedError<ContentWriteError>()(
    "ContentWriteError",
    { kind: ContentWriterErrorKind },
) {}

export class PhotoWriteError extends Schema.TaggedError<PhotoWriteError>()("PhotoWriteError", {
    reason: Schema.Literals(["InvalidKey", "InvalidImage", "TooLarge"]),
}) {}

export class NoteSubmissionError extends Schema.TaggedError<NoteSubmissionError>()(
    "NoteSubmissionError",
    { reason: Schema.Literals(["invalid", "forbidden", "throttled", "unavailable"]) },
) {}
