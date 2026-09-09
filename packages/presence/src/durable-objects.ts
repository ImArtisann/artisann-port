import { DurableObject } from "cloudflare:workers";
import type {
    DurableObjectState,
    Request as NativeRequest,
    Response as NativeResponse,
    WebSocket,
    WebSocketPair as NativeWebSocketPair,
} from "@cloudflare/workers-types";
import { PresenceController } from "./presence-object.ts";
import type { PresenceSnapshot } from "./schema.ts";
import type { PresenceKvBinding } from "./store.ts";
import { ContentWriterController } from "./content-writer-object.ts";
import type {
    ContentWriterAction,
    ContentWriterEnv,
    ContentWriterErrorKind,
    ContentWriterResult,
    ContentWriterState,
} from "./content-writer.ts";

declare const WebSocketPair: typeof NativeWebSocketPair;
declare const Response: typeof NativeResponse;

/** Existing class identity and storage namespace remain unchanged. */
export class ContentWriter extends DurableObject<ContentWriterEnv> {
    readonly controller: ContentWriterController;
    constructor(state: DurableObjectState, env: ContentWriterEnv) {
        super(state, env);
        this.controller = new ContentWriterController(state, env);
    }
    getState(): Promise<ContentWriterState> {
        return this.controller.getState();
    }
    apply(
        action: ContentWriterAction,
    ): Promise<ContentWriterResult | { error: ContentWriterErrorKind }> {
        return this.controller.apply(action);
    }
    override alarm(): Promise<void> {
        return this.controller.alarm();
    }
}

export interface PresenceObjectEnv {
    readonly PRESENCE_KV: PresenceKvBinding;
}

/** Native adapter only: attached sockets and alarms are owned by workerd. */
export class PresenceDO extends DurableObject<PresenceObjectEnv> {
    readonly controller: PresenceController;
    constructor(state: DurableObjectState, env: PresenceObjectEnv) {
        super(state, env);
        this.controller = new PresenceController(state.storage, env.PRESENCE_KV, () =>
            state.getWebSockets(),
        );
    }

    getSnapshot(): Promise<PresenceSnapshot> {
        return this.controller.getSnapshot();
    }
    publishSnapshot(snapshot: PresenceSnapshot): Promise<PresenceSnapshot> {
        return this.controller.publishSnapshot(snapshot);
    }
    override alarm(): Promise<void> {
        return this.controller.alarm();
    }

    override fetch(request: NativeRequest): Promise<NativeResponse> {
        if (request.method !== "GET") return Promise.resolve(new Response(null, { status: 405 }));
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
            return Promise.resolve(new Response(null, { status: 426 }));
        const pair = new WebSocketPair();
        return this.controller
            .connect(pair[1], () => this.ctx.acceptWebSocket(pair[1]))
            .then(() => new Response(null, { status: 101, webSocket: pair[0] }));
    }

    override webSocketMessage(socket: WebSocket): void {
        try {
            socket.close(1008, "Presence is read-only");
        } catch {
            /* Already closed. */
        }
    }
    override webSocketClose(socket: WebSocket, code: number, reason: string): void {
        try {
            socket.close(code, reason);
        } catch {
            /* Other peers remain independent. */
        }
    }
    override webSocketError(socket: WebSocket): void {
        try {
            socket.close(1011, "Socket unavailable");
        } catch {
            /* Already closed. */
        }
    }
}
