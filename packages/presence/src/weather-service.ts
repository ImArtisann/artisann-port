import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ApiUnavailable } from "./api-errors.ts";
import type { WeatherReading } from "./rpc.ts";

const WEATHER_URL =
    "https://api.open-meteo.com/v1/forecast?latitude=32.9343&longitude=-97.0781&hourly=temperature_2m&current=temperature_2m";

const CurrentTemperature = Schema.Struct({
    current: Schema.Struct({ temperature_2m: Schema.Finite }),
    current_units: Schema.Struct({ temperature_2m: Schema.NonEmptyString }),
});

export class WeatherService extends Context.Service<
    WeatherService,
    { readonly get: Effect.Effect<WeatherReading, ApiUnavailable> }
>()("Weather.Service") {}

/** Fixed Open-Meteo provider; no caller-controlled URL or coordinates. */
export const WeatherLive = Layer.effect(
    WeatherService,
    Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const get = client.get(WEATHER_URL, { headers: { accept: "application/json" } }).pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(CurrentTemperature)),
            Effect.timeout("10 seconds"),
            // Open-Meteo rejects traceparent and would fail a CORS preflight.
            Effect.provideService(HttpClient.TracerPropagationEnabled, false),
            Effect.map((response) => ({
                temperature: response.current.temperature_2m,
                unit: response.current_units.temperature_2m,
            })),
            Effect.mapError(() => new ApiUnavailable({ operation: "weather.get" })),
            Effect.withSpan("WeatherService.get"),
        );
        return WeatherService.of({ get });
    }),
);
