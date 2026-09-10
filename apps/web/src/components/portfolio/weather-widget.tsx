/** @jsxImportSource react */
import {
    Card,
    CardAction,
    CardContent,
    CardHeader,
    CardTitle,
} from "@artisann-port/ui/components/card";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { SunCloud02Icon } from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useState } from "react";

/**
 * Open-Meteo current temperature for the studio's metro area. The endpoint is fixed source config;
 * the rendered copy only ever names the city, never the coordinates.
 */
const WEATHER_URL =
    "https://api.open-meteo.com/v1/forecast?latitude=32.9343&longitude=-97.0781&hourly=temperature_2m&current=temperature_2m";

/** Open-Meteo updates its current block every 15 minutes; polling faster would only burn requests. */
const REFRESH_INTERVAL_MS = 900_000;

/**
 * Only the fields this widget renders. `current_units.temperature_2m` carries the unit the API
 * actually returned (Celsius for this request), so the UI never has to guess a scale.
 */
const CurrentTemperature = Schema.Struct({
    current: Schema.Struct({ temperature_2m: Schema.Finite }),
    current_units: Schema.Struct({ temperature_2m: Schema.NonEmptyString }),
});

interface Reading {
    /** Temperature exactly as decoded: finite, possibly zero or negative. */
    readonly temperature: number;
    /** Unit label the API reported, e.g. `°C`. */
    readonly unit: string;
}

interface WeatherState {
    /** Last successfully decoded reading, or `null` before the first success. */
    readonly reading: Reading | null;
    /** `false` until the first request settles, so the UI can say "checking" instead of "unavailable". */
    readonly settled: boolean;
    /** `true` when the most recent request failed; any retained reading is stale, not current. */
    readonly failed: boolean;
}

const INITIAL_STATE: WeatherState = { reading: null, settled: false, failed: false };

const decodeBody = HttpClientResponse.schemaBodyJson(CurrentTemperature);

const readTemperature = HttpClient.get(WEATHER_URL, {
    headers: { accept: "application/json" },
}).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(decodeBody),
    Effect.timeout("10 seconds"),
    // Open-Meteo does not allow `traceparent`, and sending it would force a failing CORS preflight.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.provide(FetchHttpClient.layer),
);

/** The endpoint reports temperature only, so the copy never claims a sky condition. */
const statusLabel = ({ reading, settled, failed }: WeatherState) => {
    if (reading === null) return settled ? "Weather unavailable" : "Waiting for weather";
    return failed ? "Last reading, refresh failed" : null;
};

export function WeatherWidget() {
    const [state, setState] = useState<WeatherState>(INITIAL_STATE);

    useEffect(() => {
        let active = true;
        let inFlight: AbortController | null = null;
        let timer: number | null = null;

        const poll = async () => {
            const attempt = new AbortController();
            inFlight = attempt;

            const exit = await Effect.runPromiseExit(readTemperature, { signal: attempt.signal });

            // Unmounted, or a newer attempt replaced this one: its result is no longer ours to publish.
            if (!active || inFlight !== attempt) return;
            inFlight = null;

            setState((previous) =>
                Exit.isSuccess(exit)
                    ? {
                          reading: {
                              temperature: exit.value.current.temperature_2m,
                              unit: exit.value.current_units.temperature_2m,
                          },
                          settled: true,
                          failed: false,
                      }
                    : { reading: previous.reading, settled: true, failed: true },
            );

            timer = window.setTimeout(() => void poll(), REFRESH_INTERVAL_MS);
        };

        void poll();

        return () => {
            active = false;
            if (timer !== null) {
                window.clearTimeout(timer);
                timer = null;
            }
            if (inFlight !== null) {
                const aborted = inFlight;
                inFlight = null;
                aborted.abort();
            }
        };
    }, []);

    const { reading } = state;
    const status = statusLabel(state);

    return (
        <Card
            role="region"
            aria-labelledby="weather-heading"
            className="h-full gap-3 [--card-spacing:--spacing(5)]"
        >
            <CardHeader className="gap-0">
                <CardTitle tone="label">
                    <h2 id="weather-heading" className="text-caption">
                        Weather in Dallas
                    </h2>
                </CardTitle>
                <CardAction className="text-muted-foreground">
                    <HugeiconsIcon icon={SunCloud02Icon} size={20} aria-hidden="true" />
                </CardAction>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
                <p
                    className="shrink-0 text-display font-semibold whitespace-nowrap"
                    aria-live="polite"
                >
                    {reading === null ? "—°" : `${Math.round(reading.temperature)}${reading.unit}`}
                </p>
                {status !== null && (
                    <p className="min-w-0 text-caption text-muted-foreground">{status}</p>
                )}
            </CardContent>
        </Card>
    );
}
