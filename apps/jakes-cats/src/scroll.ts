import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type { Message } from "./app-state.ts";

const ScrollPosition = Schema.Struct({ catsScroll: Schema.Number });
export const readScroll = (): number => {
    const state = Schema.decodeUnknownOption(ScrollPosition)(history.state);
    return Option.isSome(state) ? state.value.catsScroll : 0;
};

export const rememberScroll = Effect.sync(() => {
    history.replaceState({ ...history.state, catsScroll: window.scrollY }, "");
});

export const restoreScroll = (top: number): Effect.Effect<Message> =>
    Effect.callback((resume) => {
        const frame = requestAnimationFrame(() => {
            window.scrollTo({ left: 0, top, behavior: "instant" });
            resume(Effect.succeed({ _tag: "Noop" }));
        });
        return Effect.sync(() => cancelAnimationFrame(frame));
    });

export const trackScroll = Stream.callback<Message>(() =>
    Effect.acquireRelease(
        Effect.sync(() => {
            history.scrollRestoration = "manual";
            const handler = () => Effect.runSync(rememberScroll);
            window.addEventListener("scroll", handler, { passive: true });
            return handler;
        }),
        (handler) => Effect.sync(() => window.removeEventListener("scroll", handler)),
    ),
);
