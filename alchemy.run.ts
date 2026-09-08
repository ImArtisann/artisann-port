import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
    "ArtisannPortfolio",
    { providers: Cloudflare.providers(), state: Cloudflare.state() },
    Effect.gen(function* () {
        const stage = yield* Alchemy.Stage;
        const zoneId =
            stage === "prod"
                ? yield* Effect.gen(function* () {
                      const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;
                      const zone = yield* Cloudflare.Zone.findZoneByName({
                          accountId,
                          name: "artisann.dev",
                      }).pipe(Effect.orDie);
                      if (!zone) {
                          return yield* Effect.die(
                              new Error('Cloudflare zone "artisann.dev" was not found'),
                          );
                      }
                      return zone.id;
                  })
                : undefined;
        const website = yield* Cloudflare.Website.Astro("Website", {
            rootDir: "apps/web",
            astro: { output: "static" },
            domain: stage === "prod" ? "www.artisann.dev" : undefined,
            compatibility: { flags: ["nodejs_compat"] },
        });

        if (zoneId) {
            yield* Cloudflare.DNS.Record("ApexRedirectDns", {
                zoneId,
                name: "artisann.dev",
                type: "CNAME",
                content: "www.artisann.dev",
                ttl: "1",
                proxied: true,
                comment: "Routes apex traffic through Cloudflare for the www redirect",
            });

            const zone: Pick<Cloudflare.Zone.Zone, "zoneId"> = {
                zoneId: Output.literal(zoneId),
            };
            yield* Cloudflare.Ruleset.Ruleset("ApexToWww", {
                // SAFETY: Ruleset reads only zoneId; do not own the existing zone.
                zone: zone as Cloudflare.Zone.Zone,
                phase: "http_request_dynamic_redirect",
                description: "Canonical apex-to-www redirect",
                rules: [
                    {
                        action: "redirect",
                        actionParameters: {
                            fromValue: {
                                targetUrl: {
                                    expression:
                                        'concat("https://www.artisann.dev", http.request.uri.path)',
                                },
                                preserveQueryString: true,
                                statusCode: 301,
                            },
                        },
                        description: "Redirect artisann.dev to www.artisann.dev",
                        enabled: true,
                        expression: 'http.host eq "artisann.dev"',
                    },
                ],
            });
        }

        return { url: website.url };
    }),
);
