import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
export const PhotoKey = Schema.String.check(Schema.isPattern(/^cats\/[0-9]{17,20}\.webp$/u));
export const VisitorId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export const Timestamp = Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u),
    // The pattern admits 2026-02-30 and 25:00; only a round trip proves a real instant.
    Schema.makeFilter<string>(
        (value) =>
            Option.exists(DateTime.make(value), (instant) => DateTime.formatIso(instant) === value)
                ? undefined
                : false,
        { identifier: "Cats.Timestamp" },
    ),
);
