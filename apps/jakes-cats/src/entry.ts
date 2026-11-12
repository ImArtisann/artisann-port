import { CatsApi } from "@artisann-port/cats-domain/cats.api";
import * as Domain from "@alchemy.run/domain";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import type * as HttpClient from "effect/http/HttpClient";
import * as Socket from "effect/socket/Socket";
import { Runtime } from "foldkit";
import { Flags, Model, init, routing, subscriptions, update, view } from "./App.ts";
import type { Message } from "./app-state.ts";
import "./styles.css";

const BrowserHttp = FetchHttpClient.layer;
const CountsConnection = CatsApi.layerClient.pipe(
    Layer.provide(Domain.protocolWebSocket(`${location.origin}/api/domain`)),
    Layer.provide([BrowserHttp, Socket.layerWebSocketConstructorGlobal]),
);

Runtime.hydrate(
    Runtime.makeApplication<
        Model,
        Message,
        Flags,
        HttpClient.HttpClient | Effect.Services<typeof CatsApi.Client>
    >({
        Flags,
        Model,
        init,
        update,
        view,
        routing,
        subscriptions,
        resources: Layer.merge(BrowserHttp, CountsConnection),
        container: document.getElementById("cats-app"),
    }),
);
