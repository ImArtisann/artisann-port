/** Canonical public DNS hostname, never an address literal or local/internal name. */
export function isPublicDnsHostname(host: string): boolean {
    if (host.length > 253 || host !== host.toLowerCase() || host !== host.trim()) return false;
    if (
        !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(
            host,
        )
    )
        return false;
    const suffix = host.slice(host.lastIndexOf(".") + 1);
    if (
        [
            "localhost",
            "local",
            "localdomain",
            "internal",
            "lan",
            "home",
            "corp",
            "onion",
            "test",
            "invalid",
            "example",
            "arpa",
        ].includes(suffix)
    )
        return false;
    try {
        const url = new URL(`https://${host}`);
        return (
            url.hostname === host && url.port === "" && url.username === "" && url.password === ""
        );
    } catch {
        return false;
    }
}

/** Discord's optional multiline field; blank input explicitly clears approval. */
export function parseOgImageHosts(input: string): string[] | null {
    const hosts: string[] = [];
    for (const line of input.split(/\r?\n/u)) {
        const host = line.trim().toLowerCase();
        if (host === "") continue;
        if (!isPublicDnsHostname(host)) return null;
        if (!hosts.includes(host)) hosts.push(host);
        if (hosts.length > 8) return null;
    }
    return hosts;
}
