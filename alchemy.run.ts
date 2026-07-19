import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
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
							return yield* Effect.die(new Error('Cloudflare zone "artisann.dev" was not found'));
						}
						return zone.id;
					})
				: undefined;
		const website = yield* Cloudflare.Website.StaticSite("Website", {
			command: "pnpm build",
			outdir: "dist",
			domain: stage === "prod" ? "www.artisann.dev" : undefined,
			compatibility: { flags: ["nodejs_compat"] },
			dev: { command: "pnpm dev:site" },
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

			// Ruleset reads only zoneId; avoid taking lifecycle ownership of the existing zone.
			const zone = { zoneId } as unknown as Cloudflare.Zone.Zone;
			yield* Cloudflare.Ruleset.Ruleset("ApexToWww", {
				zone,
				phase: "http_request_dynamic_redirect",
				description: "Canonical apex-to-www redirect",
				rules: [
					{
						action: "redirect",
						actionParameters: {
							fromValue: {
								targetUrl: {
									expression: 'concat("https://www.artisann.dev", http.request.uri.path)',
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
