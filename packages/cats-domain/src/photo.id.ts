import * as Schema from "effect/Schema";
export const PhotoKey = Schema.String.check(Schema.isPattern(/^cats\/[0-9]{17,20}\.webp$/u));
export const VisitorId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export const Timestamp = Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
);
