interface ImportMetaEnv {
    readonly PUBLIC_PORTFOLIO_API_URL?: string;
    readonly PUBLIC_ASSETS_HOST?: string;
    readonly PUBLIC_ASSETS_TRANSFORM?: string;
    readonly PUBLIC_TURNSTILE_SITE_KEY?: string;
    readonly PUBLIC_NOTES_COMPOSER?: string;
    readonly TRAKS_SITE_KEY?: string;
}
interface ImportMeta {
    readonly env: ImportMetaEnv;
}
declare module "virtual:foldkit/fetch" {
    const handler: { fetch(request: Request): Promise<Response> };
    export default handler;
}
