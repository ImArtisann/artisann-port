import * as DomainCloudflare from "@alchemy.run/cloudflare/Domain";
import { Portfolio, PortfolioHandlers } from "@artisann-port/portfolio-domain/portfolio.model";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { NativePortfolioBindingsLive } from "./portfolio-bindings.ts";
import { KvContentDocumentsLive } from "./content-document-store.ts";
import { CmsContentLive } from "./cms-service.ts";
import { PortfolioMigrationLive } from "./content-migration-service.ts";
import { PhotoDomainLive } from "./photo-domain-service.ts";
import { PhotosLive } from "./photos-service.ts";
import { PresenceLive } from "./presence-service.ts";
import { GithubLive } from "./github.ts";
import { NotesLive } from "./notes-service.ts";
import { WeatherLive } from "./weather-service.ts";

const NativeCapabilities = Layer.mergeAll(
    NativePortfolioBindingsLive,
    FetchHttpClient.layer,
    DomainCloudflare.layerDurableObjects(),
);
const ContentStorage = KvContentDocumentsLive.pipe(Layer.provideMerge(NativeCapabilities));
const HostedPortfolio = Portfolio.layer(PortfolioHandlers).pipe(Layer.provideMerge(ContentStorage));
const PhotoWorkflows = PhotoDomainLive.pipe(Layer.provideMerge(HostedPortfolio));
export const PortfolioLive = Layer.mergeAll(
    CmsContentLive,
    PortfolioMigrationLive,
    PhotosLive,
    PresenceLive,
    GithubLive,
    NotesLive,
    WeatherLive,
).pipe(Layer.provideMerge(PhotoWorkflows));
