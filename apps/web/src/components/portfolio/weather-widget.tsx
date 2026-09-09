/** @jsxImportSource react */
import {
    Card,
    CardAction,
    CardContent,
    CardHeader,
    CardTitle,
} from "@artisann-port/ui/components/card";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { useAtomValue } from "@effect/atom-react";
import { SunCloud02Icon } from "@hugeicons-pro/core-solid-rounded";
import { HugeiconsIcon } from "@hugeicons/react";
import { SharedAtomRegistry } from "@/lib/atom-registry";
import { portfolioApiEndpoints, weatherAtom } from "@/lib/rpc-client";

/** The endpoint reports temperature only, so the copy never claims a sky condition. */
const statusLabel = (
    reading: { readonly temperature: number; readonly unit: string } | null,
    settled: boolean,
    failed: boolean,
) => {
    if (reading === null) return settled ? "Weather unavailable" : "Waiting for weather";
    return failed ? "Last reading, refresh failed" : null;
};

function WeatherWidgetContent() {
    const result = useAtomValue(weatherAtom(portfolioApiEndpoints.rpcUrl));
    const reading = AsyncResult.getOrElse(result, () => null);
    const settled = !AsyncResult.isInitial(result);
    const failed = AsyncResult.isFailure(result);
    const status = statusLabel(reading, settled, failed);

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

export function WeatherWidget() {
    return (
        <SharedAtomRegistry>
            <WeatherWidgetContent />
        </SharedAtomRegistry>
    );
}
