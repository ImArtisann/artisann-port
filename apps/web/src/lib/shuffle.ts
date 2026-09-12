/**
 * Fisher-Yates shuffle returning a new array; the input is never mutated.
 * `Math.random` is intentional: ordering only needs to differ per visit.
 */
export function shuffle<T>(items: readonly T[]): T[] {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
        // A React-side shuffle, outside any Effect runtime: the randomized presentation order
        // is not data the Effect Random service owns.
        // oxlint-disable-next-line effecttsgo/global-random
        const swap = Math.floor(Math.random() * (index + 1));
        const item = result[index]!;
        result[index] = result[swap]!;
        result[swap] = item;
    }
    return result;
}

/**
 * Keep the prior (possibly shuffled) order for entries that still exist and
 * append newly seen entries at the end. Returns `prior` unchanged when the key
 * sequence is identical so callers can bail out of a state update.
 */
export function reconcileOrder<T>(
    prior: readonly T[],
    next: readonly T[],
    keyOf: (item: T) => string,
): readonly T[] {
    const nextByKey = new Map(next.map((item) => [keyOf(item), item]));
    const kept = prior.flatMap((item) => {
        const current = nextByKey.get(keyOf(item));
        return current === undefined ? [] : [current];
    });
    const priorKeys = new Set(prior.map(keyOf));
    const added = next.filter((item) => !priorKeys.has(keyOf(item)));
    if (
        added.length === 0 &&
        kept.length === prior.length &&
        kept.every((item, index) => item === prior[index])
    ) {
        return prior;
    }
    return [...kept, ...added];
}
