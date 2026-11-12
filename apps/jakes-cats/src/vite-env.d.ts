declare module "virtual:foldkit/fetch" {
    const pages: {
        readonly fetch: (request: Request) => Promise<Response>;
    };
    export default pages;
}
