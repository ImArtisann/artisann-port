import * as Schema from "effect/Schema";

export const ContributionLevel = Schema.Literals([
    "NONE",
    "FIRST_QUARTILE",
    "SECOND_QUARTILE",
    "THIRD_QUARTILE",
    "FOURTH_QUARTILE",
]);
const ContributionDay = Schema.Struct({
    date: Schema.String,
    weekday: Schema.Finite,
    contributionCount: Schema.Finite,
    contributionLevel: ContributionLevel,
});

export const ContributionCalendar = Schema.Struct({
    totalContributions: Schema.Finite,
    weeks: Schema.Array(
        Schema.Struct({
            firstDay: Schema.String,
            contributionDays: Schema.Array(ContributionDay),
        }),
    ),
});

export const GithubSnapshot = Schema.Struct({
    year: Schema.Finite,
    calendar: ContributionCalendar,
    updatedAt: Schema.String,
    stale: Schema.Boolean,
});
export type GithubSnapshot = typeof GithubSnapshot.Type;
