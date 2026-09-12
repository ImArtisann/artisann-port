/**
 * The comment section's local spam filter, run before any storage write. It is
 * a pure string scan — no Effect, no I/O — so it can be unit-tested directly
 * and stays cheap on every comment. It only catches vandalism shapes
 * (character floods, link dumps, symbol soup); profanity is judged by the
 * remote moderation service, which keeps its vocabulary out of this repo.
 */

/** Code points, not UTF-16 units: astral characters count once everywhere. */
const codePointCount = (text: string): number => {
    let total = 0;
    for (const _char of text) total += 1;
    return total;
};

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/** One character making up ≥60% of the body, at least eight times over. */
const isCharacterFlood = (body: string): boolean => {
    const compact = body.replace(/\s+/g, "");
    const counts = new Map<string, number>();
    let total = 0;
    for (const char of compact) {
        counts.set(char, (counts.get(char) ?? 0) + 1);
        total += 1;
    }
    if (total === 0) return false;
    let top = 0;
    for (const count of counts.values()) top = Math.max(top, count);
    return top >= 8 && top / total >= 0.6;
};

/** More than one URL, or one URL with under ten other non-space characters. */
const isLinkDump = (body: string): boolean => {
    const urls = body.match(/https?:\/\/\S+/gi) ?? [];
    if (urls.length > 1) return true;
    if (urls.length === 0) return false;
    const rest = body.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, "");
    return codePointCount(rest) < 10;
};

/** Under a fifth of the non-space characters are letters or digits. */
const isSymbolFlood = (body: string): boolean => {
    const compact = body.replace(/\s+/g, "");
    let total = 0;
    let alphanumeric = 0;
    for (const char of compact) {
        total += 1;
        if (ALPHANUMERIC.test(char)) alphanumeric += 1;
    }
    if (total === 0) return false;
    return alphanumeric / total < 0.2;
};

/** `"spam"` when the body is a vandalism shape, or `null` when it may be stored. */
export const spamProblem = (body: string): "spam" | null => {
    if (isCharacterFlood(body) || isLinkDump(body) || isSymbolFlood(body)) return "spam";
    return null;
};
