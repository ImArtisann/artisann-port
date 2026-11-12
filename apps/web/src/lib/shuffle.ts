/** Preserve surviving entries in their browse order and append newly published entries. */
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
