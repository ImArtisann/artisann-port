import * as Domain from "@alchemy.run/domain";
import { PortfolioApi } from "@artisann-port/portfolio-domain/portfolio.api";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { Flags, Model, init, subscriptions, update } from "./main.ts";
import { portfolioHttpLayer } from "./lib/api-client.ts";
import { view } from "./view.ts";
import "./styles.css";

const domain = PortfolioApi.layerClient.pipe(
    Layer.provide(Domain.protocolWebSocket(`${location.origin}/api/domain`)),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
);
const resources = Layer.mergeAll(domain, portfolioHttpLayer(location.origin)).pipe(
    Layer.provide(FetchHttpClient.layer),
);

Runtime.hydrate(
    Runtime.makeApplication({
        Model,
        Flags,
        init,
        update,
        view,
        subscriptions,
        resources,
        container: document.querySelector<HTMLElement>("[data-foldkit-app]"),
    }),
);
