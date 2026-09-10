/** Import native module types without installing competing Worker globals alongside Bun. */
declare module "cloudflare:workers" {
    export const DurableObject: typeof import("@cloudflare/workers-types").CloudflareWorkersModule.DurableObject;
}
