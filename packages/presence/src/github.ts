import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import { ContributionCalendar, GithubSnapshot } from "./github-schema.ts";
import type { PresenceKvBinding } from "./store.ts";

const CACHE_KEY = "github-contributions";
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const SnapshotDocument = Schema.fromJsonString(GithubSnapshot);
const decodeDocument = Schema.decodeUnknownEffect(SnapshotDocument);
const encodeDocument = Schema.encodeEffect(SnapshotDocument);

export const GITHUB_QUERY = `query Contributions($login: String!, $from: DateTime!, $to: DateTime!) {
  user(login: $login) {
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        totalContributions
        weeks {
          firstDay
          contributionDays { date weekday contributionCount contributionLevel }
        }
      }
    }
  }
}`;

const GraphqlResponse = Schema.Struct({
    data: Schema.optionalKey(
        Schema.NullOr(
            Schema.Struct({
                user: Schema.NullOr(
                    Schema.Struct({
                        contributionsCollection: Schema.Struct({
                            contributionCalendar: ContributionCalendar,
                        }),
                    }),
                ),
            }),
        ),
    ),
    errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.String }))),
});

class GithubError extends Schema.TaggedError<GithubError>()("GithubError", {
    message: Schema.String,
}) {}

export const readGithub = Effect.fn("Github.read")(function* (namespace: PresenceKvBinding) {
    const document = yield* Effect.tryPromise({
        try: () => namespace.get(CACHE_KEY),
        catch: () => new GithubError({ message: "Could not read cached GitHub contributions" }),
    });
    if (document === null) return null;
    const snapshot = yield* decodeDocument(document);
    return {
        year: snapshot.year,
        calendar: snapshot.calendar,
        updatedAt: snapshot.updatedAt,
        stale: Date.now() - Date.parse(snapshot.updatedAt) > MAX_AGE_MS,
    } satisfies GithubSnapshot;
});

/** GraphQL errors never replace the last successfully cached calendar. */
export const refreshGithub = Effect.fn("Github.refresh")(function* (
    namespace: PresenceKvBinding,
    token: Redacted.Redacted<string>,
) {
    const now = new Date();
    const year = now.getUTCFullYear();
    const request = HttpClientRequest.post("https://api.github.com/graphql", {
        headers: {
            authorization: `Bearer ${Redacted.value(token)}`,
            "user-agent": "artisann-portfolio",
            accept: "application/vnd.github+json",
        },
    }).pipe(
        HttpClientRequest.bodyJsonUnsafe({
            query: GITHUB_QUERY,
            variables: {
                login: "ImArtisann",
                from: `${year}-01-01T00:00:00Z`,
                to: `${year}-12-31T23:59:59Z`,
            },
        }),
    );
    const result = yield* HttpClient.execute(request).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GraphqlResponse)),
        Effect.timeout("20 seconds"),
        // Do not put the authenticated request or its headers in platform error logs.
        Effect.mapError(() => new GithubError({ message: "GitHub GraphQL request failed" })),
    );
    if (result.errors?.length || !result.data?.user) {
        return yield* new GithubError({
            message: "GitHub GraphQL did not return a contribution calendar",
        });
    }
    const snapshot: GithubSnapshot = {
        year,
        calendar: result.data.user.contributionsCollection.contributionCalendar,
        updatedAt: now.toISOString(),
        stale: false,
    };
    const document = yield* encodeDocument(snapshot);
    yield* Effect.tryPromise({
        try: () => namespace.put(CACHE_KEY, document),
        catch: () => new GithubError({ message: "Could not save GitHub contributions" }),
    });
    return snapshot;
});
