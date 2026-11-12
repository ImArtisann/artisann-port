import { DEFAULT_ASSETS_HOST } from "@artisann-port/assets/config";
import { assetDimensions, assetHost, assetUrl, requireAssetPath } from "@artisann-port/assets/urls";
import * as Server from "foldkit/experimental/server";
import { styles as noteStyles } from "./components/notes.ts";
import { handlePortfolioRequest } from "./ssr.ts";

export const prerenderPaths = ["/"];
const TITLE = "Artisann | Developer & Automation Architect";
const DESCRIPTION =
    "Artisann — a developer and automation architect in Dallas. Projects, open source, and a little about me.";
const IMAGE_ALT =
    "Artisann — developer and automation architect in Dallas, with two pixel-art cats on a dark background.";
const escape = (value: string) =>
    value.replace(/[&<>"']/gu, (character) => {
        switch (character) {
            case "&":
                return "&amp;";
            case "<":
                return "&lt;";
            case ">":
                return "&gt;";
            case '"':
                return "&quot;";
            default:
                return "&#39;";
        }
    });
const socialAsset = requireAssetPath("opengraph/site.png");
const socialHost = assetHost(import.meta.env.PUBLIC_ASSETS_HOST ?? "") || DEFAULT_ASSETS_HOST;
const socialImage = assetUrl(socialAsset, `https://${socialHost}`);
const dimensions = assetDimensions(socialAsset);
const traksSiteKey = (import.meta.env.TRAKS_SITE_KEY ?? "").trim();
const head = `
<meta name="description" content="${escape(DESCRIPTION)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Artisann">
<meta property="og:title" content="${escape(TITLE)}">
<meta property="og:description" content="${escape(DESCRIPTION)}">
<meta property="og:image" content="${escape(socialImage)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="${dimensions.width}">
<meta property="og:image:height" content="${dimensions.height}">
<meta property="og:image:alt" content="${escape(IMAGE_ALT)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escape(TITLE)}">
<meta name="twitter:description" content="${escape(DESCRIPTION)}">
<meta name="twitter:image" content="${escape(socialImage)}">
<meta name="twitter:image:alt" content="${escape(IMAGE_ALT)}">
<meta name="theme-color" content="#111214">
<link rel="icon" href="/favicon.ico" sizes="any">
<script defer src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"></script>
${traksSiteKey === "" ? "" : `<script>window.traks=window.traks||function(){(window.traks.q=window.traks.q||[]).push(arguments)}</script><script defer data-site="${escape(traksSiteKey)}" src="https://analytics-collect.artisann.dev/t.js"></script>`}
<script>try{const dark=localStorage.getItem("theme")!=="light";document.documentElement.classList.toggle("dark",dark);document.querySelector('meta[name="theme-color"]')?.setAttribute("content",dark?"#111214":"#F5F6F7")}catch{}</script>
<style>${noteStyles}</style>`;

export const renderDocument: Server.DocumentRenderer = (application, assets) =>
    Server.renderDocument(application, assets, { lang: "en", head }).replace(
        "<html ",
        '<html class="dark" ',
    );

export const renderPage = (request: Request): Promise<Server.EntryResult> =>
    handlePortfolioRequest(request);
