import { parseEnv, stripVTControlCharacters } from "node:util";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as BunServices from "@effect/platform-bun/BunServices";
import { runMain } from "@effect/platform-bun/BunRuntime";

class DevelopmentError extends Schema.TaggedError<DevelopmentError>()("DevelopmentError", {
    message: Schema.String,
}) {}

const options = {
    stdin: "inherit",
    stderr: "inherit",
    extendEnv: true,
    killSignal: "SIGTERM",
    forceKillAfter: "5 seconds",
} satisfies ChildProcess.CommandOptions;

const development = Effect.gen(function* () {
    const apiOnly = yield* Config.boolean("PORTFOLIO_DEV_API_ONLY").pipe(Config.withDefault(false));
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(".env.discord");
    const environment = yield* Effect.try({
        try: () => parseEnv(text),
        catch: () => new DevelopmentError({ message: "Could not parse .env.discord." }),
    });
    const ready = yield* Deferred.make<void>();
    const api = yield* ChildProcess.make(
        "bun",
        [
            "--no-env-file",
            "run",
            "alchemy",
            "dev",
            "packages/presence/alchemy.run.ts",
            "--stage",
            "dev",
        ],
        {
            ...options,
            stdout: "pipe",
            env: { ...environment, CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000" },
        },
    );
    yield* api.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runForEach((line) =>
            Effect.gen(function* () {
                yield* Console.log(line);
                if (
                    stripVTControlCharacters(line).includes(
                        "[Presence] ready at http://localhost:1338",
                    )
                ) {
                    yield* Deferred.succeed(ready, undefined);
                }
            }),
        ),
        Effect.forkScoped,
    );
    const apiExit = api.exitCode.pipe(
        Effect.flatMap((code) =>
            Effect.fail(
                new DevelopmentError({ message: `Local Worker exited with code ${code}.` }),
            ),
        ),
    );
    yield* Deferred.await(ready).pipe(Effect.timeout("60 seconds"), Effect.raceFirst(apiExit));
    yield* Console.log("Local API ready at http://localhost:1338 (isolated storage).");
    if (apiOnly) return yield* apiExit;

    const web = yield* ChildProcess.make(
        "bun",
        ["--no-env-file", "run", "--cwd", "apps/web", "dev"],
        {
            ...options,
            stdout: "inherit",
            env: {
                PUBLIC_PORTFOLIO_API_URL: "http://localhost:1338",
                PUBLIC_NOTES_COMPOSER: "disabled",
            },
        },
    );
    const bot = yield* ChildProcess.make("bun", ["--no-env-file", "apps/discord/src/main.ts"], {
        ...options,
        stdout: "inherit",
        env: { ...environment, PORTFOLIO_API_URL: "http://localhost:1338" },
    });
    return yield* Effect.raceAllFirst([
        apiExit,
        web.exitCode.pipe(
            Effect.flatMap((code) =>
                Effect.fail(new DevelopmentError({ message: `Astro exited with code ${code}.` })),
            ),
        ),
        bot.exitCode.pipe(
            Effect.flatMap((code) =>
                Effect.fail(
                    new DevelopmentError({ message: `Discord bot exited with code ${code}.` }),
                ),
            ),
        ),
    ]);
});

runMain(development.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
