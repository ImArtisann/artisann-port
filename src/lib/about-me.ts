
type WorkExperience = {
    logo: string,
    company: string,
    role: string,
    technologies: string[],
    description: string,
    start: string,
    end: string
}

export const workExperiences: WorkExperience[] = [
    {
        logo: '/verizon-logo.png',
        company: 'Verizon',
        role: 'Software Engineer - Automation & Device Intelligence',
        technologies: ['TS', 'Java', 'Python'],
        description: 'Developed and maintained automation frameworks for device testing, improving efficiency and reducing manual testing efforts. Collaborated with telecom protocol teams to analyze signaling flows (SIP, VoLTE, IMS) identify defects and support fast releases.',
        start: '2025',
        end: 'Present'
    },
    {
        logo: '/perforce-logo.png',
        company: 'Perforce Software',
        role: 'Systems Engineer',
        technologies: ['ADB', 'Mobile Testing'],
        description: 'Managed global automation labs for perfecto. Supporting high-scale mobile testing environments.',
        start: '2021',
        end: '2025'
    }
]

type PersonalProject = {
    name: string,
    description: string,
    technologies: string[],
    link?: string,
    badge?: 'soon' | 'deprecated'
}

export const personalProjects: PersonalProject[] = [
    {
        name: 'Blocky',
        description: 'Official Notion (notion.so) integration allowing users to create customizable widgets dynamically from their notion data sources.',
        technologies: ['React','Next.js', 'Postgres', 'Redis', 'Effect-TS'],
        link: 'https://www.blocky.so'
    },
    {
        name: 'SynqUp (In development)',
        description: 'Cross-platform app for group planning with auto-synced calendars, social event feeds, and trip coordination features.',
        technologies: ['React Native', 'Expo', 'Google, Apple, and Outlook calendar APIs'],
        badge: 'soon'
    },
    {
        name: 'Brigade',
        description: 'Multi-Wallet crypto trading platform. Executed over 160k+ in user trading volume across 8 decentralized protocols with real-time price feeds',
        technologies: ['Telegram', 'Solana', 'Node.js', 'Go'],
        badge: 'deprecated'
    },
    {
        name: 'Twisted Fate',
        description: 'A fully automated virtual betting game/experience for League of Legends. Served over 10k+ users with persistent rank, rewards systems, and real-time match tracking.',
        technologies: ['RIOT API', 'Java', 'Discord'],
        badge: 'deprecated'
    }
]

type OpenSourceProject = {
    name: string,
    description: string,
    technologies: string[],
    link: string
}

export const openSourceProjects: OpenSourceProject[] = [
    {
        name: 'Fillcut',
        description: 'FillCut is a tool that automatically removes filler words, pauses, and coughs from video files.',
        technologies: ['TS', 'Whisper', 'FFmpeg'],
        link: 'https://github.com/ImArtisann/fillcut'
    },
    {
        name: 'Pump.fun Websocket',
        description: 'Package to easily subscribe to events that take place on pump.fun subscribe to new trades created or to new coins created',
        technologies: ['JS', 'Socket.IO'],
        link: 'https://github.com/ImArtisann/Pump.fun-Websocket'
    }
]