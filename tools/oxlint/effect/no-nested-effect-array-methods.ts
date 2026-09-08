import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const ignoredKeys = {
    end: true,
    loc: true,
    parent: true,
    range: true,
    start: true,
} as const;

const functionBoundaryTypes = {
    ArrowFunctionExpression: true,
    FunctionDeclaration: true,
    FunctionExpression: true,
} as const;

type NodeValue = ESTree.Node | readonly ESTree.Node[] | null | undefined;

const isNode = (value: NodeValue): value is ESTree.Node =>
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type !== undefined;

const isEffectArrayCall = (node: ESTree.Node): node is ESTree.CallExpression => {
    if (node.type !== "CallExpression") {
        return false;
    }

    return (
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        node.callee.object.name === "Array" &&
        node.callee.property.type === "Identifier"
    );
};

const containsEffectArrayCall = ({
    node,
    seen,
}: {
    node: ESTree.Node;
    seen: WeakSet<ESTree.Node>;
}): boolean => {
    if (seen.has(node)) {
        return false;
    }

    seen.add(node);

    if (isEffectArrayCall(node)) {
        return true;
    }

    if (Object.hasOwn(functionBoundaryTypes, node.type)) {
        return false;
    }

    for (const [key, value] of Object.entries(node)) {
        if (Object.hasOwn(ignoredKeys, key)) {
            continue;
        }

        if (Array.isArray(value)) {
            if (
                value.some((item) => isNode(item) && containsEffectArrayCall({ node: item, seen }))
            ) {
                return true;
            }

            continue;
        }

        if (isNode(value) && containsEffectArrayCall({ node: value, seen })) {
            return true;
        }
    }

    return false;
};

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Avoid nested Effect Array method calls; compose them with pipe to preserve inference.",
        },
        messages: {
            nestedEffectArray:
                "Do not nest Effect Array method calls. Use pipe to preserve inference.",
        },
    },
    create(context) {
        let arrayImportedFromEffect = false;

        return {
            Program(node) {
                arrayImportedFromEffect = node.body.some(
                    (statement) =>
                        statement.type === "ImportDeclaration" &&
                        statement.source.value === "effect" &&
                        statement.specifiers.some(
                            (specifier) =>
                                specifier.type === "ImportSpecifier" &&
                                (specifier.imported.type === "Identifier"
                                    ? specifier.imported.name
                                    : specifier.imported.value) === "Array" &&
                                specifier.local.name === "Array",
                        ),
                );
            },
            CallExpression(node) {
                if (!arrayImportedFromEffect || !isEffectArrayCall(node)) {
                    return;
                }

                if (
                    node.arguments.some(
                        (argument) =>
                            isNode(argument) &&
                            containsEffectArrayCall({
                                node: argument,
                                seen: new WeakSet<object>(),
                            }),
                    )
                ) {
                    context.report({
                        node,
                        messageId: "nestedEffectArray",
                    });
                }
            },
        };
    },
});

export default rule;
