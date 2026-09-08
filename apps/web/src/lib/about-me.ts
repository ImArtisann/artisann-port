type Accent = "violet" | "cyan" | "green" | "peach" | "muted";

type ResponsiveText = { desktop: string; mobile: string };

type PortfolioLink = { desktopLabel: string; mobileLabel: string; href?: string };

type ProfileLink = PortfolioLink & { id: "github" | "x" | "email" };

type LedgerMeta = {
    desktopLeft: string;
    desktopRight: string;
    mobileLeft: string;
    mobileRight: string;
};

type WorkExperience = {
    company: string;
    role: string;
    meta: LedgerMeta;
    description: ResponsiveText;
    proof: ResponsiveText;
    technologyLabel: ResponsiveText;
    focus?: string;
    accent: Accent;
};

type PersonalProject = {
    name: string;
    meta: LedgerMeta;
    description: ResponsiveText;
    proof: string;
    technologies: string[];
    href?: string;
    desktopAction: string;
    mobileAction: string;
    accent: Accent;
};

type OpenSourceProject = {
    name: string;
    description: ResponsiveText;
    href: string;
    accent: Accent;
    technologies: { name: string; role: string }[];
};

type ContactAudience = { label: string; title: string; detail: ResponsiveText; accent: Accent };

type PortfolioConfig = {
    profile: {
        monogram: string;
        name: string;
        role: ResponsiveText;
        location: string;
        links: ProfileLink[];
        currentFocus: string[];
        selectedWork: PortfolioLink[];
    };
    sectionCopy: Record<
        "experience" | "work" | "openSource",
        {
            contextLeft: ResponsiveText;
            contextRight: ResponsiveText;
            headline: ResponsiveText;
            summary: ResponsiveText;
        }
    >;
    workExperiences: WorkExperience[];
    personalProjects: PersonalProject[];
    openSourceProjects: OpenSourceProject[];
    contact: {
        emailHref: string;
        prompt: string;
        detail: ResponsiveText;
        audiences: ContactAudience[];
    };
    footer: { explore: PortfolioLink[]; elsewhere: PortfolioLink[] };
};

export const portfolio: PortfolioConfig = {
    profile: {
        monogram: "A",
        name: "ARTISANN",
        role: { desktop: "DEVELOPER / AUTOMATION ARCHITECT", mobile: "DEV / AUTOMATION" },
        location: "DALLAS / REMOTE",
        links: [
            {
                id: "github",
                desktopLabel: "GitHub ↗",
                mobileLabel: "GH ↗",
                href: "https://github.com/ImArtisann",
            },
            { id: "x", desktopLabel: "X ↗", mobileLabel: "X ↗", href: "https://x.com/IArtisann" },
            {
                id: "email",
                desktopLabel: "Email ↗",
                mobileLabel: "MAIL ↗",
                href: "mailto:hello@artisann.dev",
            },
        ],
        currentFocus: ["Device intelligence", "Realtime infrastructure", "Human-centered tooling"],
        selectedWork: [
            {
                desktopLabel: "Blocky — Notion tools ↗",
                mobileLabel: "Blocky · Notion ↗",
                href: "https://www.blocky.so",
            },
            { desktopLabel: "SynqUp — Group planning ↗", mobileLabel: "SynqUp · Mobile ↗" },
            {
                desktopLabel: "Zed Herdr — Dev tools ↗",
                mobileLabel: "Zed Herdr · Tools ↗",
                href: "https://github.com/ImArtisann/zed-herdr",
            },
        ],
    },
    sectionCopy: {
        experience: {
            contextLeft: { desktop: "PROFESSIONAL EXPERIENCE", mobile: "PROFESSIONAL EXPERIENCE" },
            contextRight: { desktop: "03 ROLES / 2021 — PRESENT", mobile: "2021 — NOW" },
            headline: {
                desktop: "Systems I helped\nkeep moving.",
                mobile: "Systems I helped\nKeep moving.",
            },
            summary: {
                desktop:
                    "From mobile testing infrastructure to forensic analysis and device intelligence, the work has always been about dependable execution.",
                mobile: "Device intelligence, forensic analysis, and mobile testing infrastructure—connected by dependable execution.",
            },
        },
        work: {
            contextLeft: { desktop: "SOLO PRODUCT ARCHIVE", mobile: "SOLO PRODUCT ARCHIVE" },
            contextRight: { desktop: "CURRENT + PAST", mobile: "CURRENT + PAST" },
            headline: {
                desktop: "Ideas I shipped\ninto the world.",
                mobile: "Ideas I shipped\ninto the\nworld.",
            },
            summary: {
                desktop:
                    "Four solo bets built end to end—some live, some open source, some sunsetted. Each one turned curiosity into something people could actually use.",
                mobile: "Four solo bets built end to end—live, open source, and sunsetted. Each one became something people could use.",
            },
        },
        openSource: {
            contextLeft: { desktop: "OPEN SOURCE", mobile: "OPEN SOURCE" },
            contextRight: { desktop: "", mobile: "" },
            headline: {
                desktop: "Built in the open.",
                mobile: "Built in the open.",
            },
            summary: {
                desktop:
                    "Three public repositories, documented through the problems they solve and the changes that moved each codebase forward. No product ventures—only code that can be read, forked, and inspected.",
                mobile: "Three public repositories, shown through the problems they solve and the real changes that moved each codebase forward.",
            },
        },
    },
    workExperiences: [
        {
            company: "Verizon",
            role: "Software Engineer — Automation & Device Intelligence",
            meta: {
                desktopLeft: "CURRENT",
                desktopRight: "2025 — PRESENT",
                mobileLeft: "CURRENT",
                mobileRight: "2025 — PRESENT",
            },
            description: {
                desktop:
                    "I build and maintain device-test automation, then work with telecom protocol teams to trace SIP, VoLTE, and IMS signaling when releases need answers quickly.",
                mobile: "Build device-test automation and trace SIP, VoLTE, and IMS signaling with telecom protocol teams.",
            },
            proof: {
                desktop:
                    "AUTOMATION THAT REDUCES MANUAL TESTING AND KEEPS DEFECT ANALYSIS CLOSE TO THE RELEASE",
                mobile: "REDUCING MANUAL TESTING / SUPPORTING RELEASES",
            },
            technologyLabel: {
                desktop: "TYPESCRIPT / JAVA / PYTHON",
                mobile: "TS / JAVA / PYTHON",
            },
            focus: "DEVICE TESTING / TELECOM",
            accent: "green",
        },
        {
            company: "Recon Forensics",
            role: "Contractor",
            meta: {
                desktopLeft: "2025 — 2026",
                desktopRight: "EXPERIENCE",
                mobileLeft: "2025 — 2026",
                mobileRight: "EXPERIENCE",
            },
            description: {
                desktop:
                    "Supported Attorney General investigations through computer forensics and blockchain analysis.",
                mobile: "Supported Attorney General investigations through computer forensics and blockchain analysis.",
            },
            proof: { desktop: "EVIDENCE WITH REAL STAKES", mobile: "EVIDENCE WITH REAL STAKES" },
            technologyLabel: {
                desktop: "OCR / BLOCKCHAIN / FORENSICS",
                mobile: "OCR / BLOCKCHAIN / FORENSICS",
            },
            accent: "cyan",
        },
        {
            company: "Perforce Software",
            role: "Systems Engineer",
            meta: {
                desktopLeft: "2021 — 2025",
                desktopRight: "EXPERIENCE",
                mobileLeft: "SYSTEMS",
                mobileRight: "2021 — 2025",
            },
            description: {
                desktop:
                    "Managed global Perfecto automation labs for high-scale mobile testing environments.",
                mobile: "Managed global Perfecto automation labs for high-scale mobile testing.",
            },
            proof: { desktop: "GLOBAL AUTOMATION LABS", mobile: "GLOBAL AUTOMATION LABS" },
            technologyLabel: {
                desktop: "ADB / PERFECTO / MOBILE TESTING",
                mobile: "ADB / PERFECTO / MOBILE TESTING",
            },
            accent: "violet",
        },
    ],
    personalProjects: [
        {
            name: "Blocky",
            meta: {
                desktopLeft: "LIVE",
                desktopRight: "NOTION INTEGRATION",
                mobileLeft: "LIVE",
                mobileRight: "NOTION INTEGRATION",
            },
            description: {
                desktop:
                    "Official Notion integration for turning live data sources into customizable website widgets.",
                mobile: "Official Notion integration for turning live data into customizable website widgets.",
            },
            proof: "OFFICIAL NOTION INTEGRATION",
            technologies: ["NEXT.JS", "POSTGRES", "REDIS", "EFFECT"],
            href: "https://www.blocky.so",
            desktopAction: "BLOCKY.SO ↗",
            mobileAction: "BLOCKY.SO ↗",
            accent: "green",
        },
        {
            name: "Brigade",
            meta: {
                desktopLeft: "SUNSETTED",
                desktopRight: "TRADING PLATFORM",
                mobileLeft: "SUNSETTED",
                mobileRight: "TRADING PLATFORM",
            },
            description: {
                desktop:
                    "Multi-wallet Solana trading across eight decentralized protocols with real-time pricing.",
                mobile: "Multi-wallet Solana trading across eight decentralized protocols with real-time pricing.",
            },
            proof: "$160K+ USER TRADING VOLUME",
            technologies: ["TELEGRAM", "SOLANA", "NODE.JS", "GO"],
            desktopAction: "BUILT / OPERATED / SUNSETTED",
            mobileAction: "SUNSETTED",
            accent: "muted",
        },
        {
            name: "Twisted Fate",
            meta: {
                desktopLeft: "SUNSETTED",
                desktopRight: "GAME AUTOMATION",
                mobileLeft: "SUNSETTED",
                mobileRight: "GAME AUTOMATION",
            },
            description: {
                desktop:
                    "Automated League of Legends betting experience with ranks, rewards, and live match tracking.",
                mobile: "Automated League of Legends betting with ranks, rewards, and live match tracking.",
            },
            proof: "10K+ USERS SERVED",
            technologies: ["RIOT API", "JAVA", "DISCORD"],
            desktopAction: "AUTOMATED / OPERATED / SUNSETTED",
            mobileAction: "SUNSETTED",
            accent: "muted",
        },
    ],
    openSourceProjects: [
        {
            name: "Zed Herdr",
            description: {
                desktop:
                    "Automatically keeps your active Herdr workspace in sync with your existing Zed session. ",
                mobile: "Automatically keeps herdr and zed sessions in sync.",
            },
            href: "https://github.com/ImArtisann/zed-herdr",
            accent: "cyan",
            technologies: [
                { name: "TypeScript", role: "APPLICATION LOGIC" },
                { name: "Effect-TS", role: "ERROR HANDLING" },
            ],
        },
        {
            name: "Pump.fun Websocket",
            description: {
                desktop:
                    "A focused package for subscribing to new trades and newly created coins in real time.",
                mobile: "Subscribe to new trades and newly created coins through a focused real-time package.",
            },
            href: "https://github.com/ImArtisann/Pump.fun-Websocket",
            accent: "violet",
            technologies: [
                { name: "JavaScript", role: "PACKAGE RUNTIME" },
                { name: "Socket.IO", role: "REAL-TIME EVENTS" },
                { name: "Docker", role: "RECONNECT ENVIRONMENT" },
            ],
        },
        {
            name: "Herdr workspace launcher",
            description: {
                desktop:
                    "A macOS Herdr plugin for quickly creating focused workspaces with a searchable, keyboard-driven directory picker.",
                mobile: "A keyboard-driven directory picker for herdr workspaces",
            },
            href: "https://github.com/ImArtisann/herdr-workspace-launcher",
            accent: "green",
            technologies: [
                { name: "TypeScript", role: "APPLICATION LOGIC" },
                { name: "Effect-TS", role: "ERROR HANDLING" },
            ],
        },
    ],
    contact: {
        emailHref: "mailto:hello@artisann.dev",
        prompt: "START WITH THE CONTEXT",
        detail: {
            desktop:
                "A short note about the role, workflow, or problem is enough. I’ll take it from there.",
            mobile: "A short note about the role, workflow, or problem is enough.",
        },
        audiences: [
            {
                label: "FOR HIRING TEAMS",
                title: "Product engineering and automation architecture.",
                detail: {
                    desktop:
                        "Developer tooling, product systems, and dependable execution across the stack.",
                    mobile: "Developer tooling, product systems, dependable execution.",
                },
                accent: "green",
            },
            {
                label: "FOR CLIENTS / COLLABORATORS",
                title: "Automation that clears the manual burden.",
                detail: {
                    desktop:
                        "Workflow automation, systems integration, and focused software builds.",
                    mobile: "Workflow automation, systems integration, focused builds.",
                },
                accent: "peach",
            },
        ],
    },
    footer: {
        explore: [
            { desktopLabel: "Selected work ↗", mobileLabel: "Selected work ↗", href: "#work" },
            { desktopLabel: "Experience ↗", mobileLabel: "Experience ↗", href: "#experience" },
            { desktopLabel: "Open source ↗", mobileLabel: "Open source ↗", href: "#open-source" },
        ],
        elsewhere: [
            {
                desktopLabel: "GitHub ↗",
                mobileLabel: "GitHub ↗",
                href: "https://github.com/ImArtisann",
            },
            {
                desktopLabel: "X / Twitter ↗",
                mobileLabel: "X / Twitter ↗",
                href: "https://x.com/IArtisann",
            },
        ],
    },
};
