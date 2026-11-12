import * as Schema from "effect/Schema";

export const Weather = Schema.Struct({
    temperature: Schema.Finite,
    unit: Schema.NonEmptyString,
});
export type Weather = typeof Weather.Type;
