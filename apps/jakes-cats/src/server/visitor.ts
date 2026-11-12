import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const VISITOR_COOKIE = "jc_visitor";
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
export const VisitorId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u));
export type VisitorId = typeof VisitorId.Type;
export const decodeVisitorId = Schema.decodeUnknownOption(VisitorId);
export function visitorIdFromBytes(bytes: Uint8Array): string {
    let id = "";
    for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
    return id;
}
export interface Visitor {
    readonly id: VisitorId;
    readonly cookie: string | null;
}
export function resolveVisitor(request: Request): Visitor {
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
        const [name, value] = part.trim().split("=");
        if (name !== VISITOR_COOKIE) continue;
        const known = decodeVisitorId(value);
        if (Option.isSome(known)) return { id: known.value, cookie: null };
    }
    const id = visitorIdFromBytes(crypto.getRandomValues(new Uint8Array(16)));
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return {
        id,
        cookie: `${VISITOR_COOKIE}=${id}; Path=/; Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
    };
}
export function clientKey(request: Request): string {
    return request.headers.get("cf-connecting-ip") ?? "unknown-client";
}
