import { defineRule } from "@oxlint/plugins";
import type { ESTree, SourceCode } from "@oxlint/plugins";

const globalFetchObjects = {
    globalThis: true,
    self: true,
    window: true,
} as const;

const isFetchProperty = ({
    computed,
    property,
}: {
    computed: boolean;
    property: ESTree.MemberExpression["property"];
}) =>
    computed
        ? property.type === "Literal" && property.value === "fetch"
        : property.type === "Identifier" && property.name === "fetch";

const isGlobalFetchObject = (sourceCode: SourceCode, object: ESTree.Expression) =>
    object.type === "Identifier" &&
    Object.hasOwn(globalFetchObjects, object.name) &&
    sourceCode.isGlobalReference(object);

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Avoid direct fetch calls; use the existing API client or runtime client service.",
        },
        messages: {
            directFetch:
                "Do not call fetch directly. Use the existing API client or runtime client service.",
        },
    },
    create(context) {
        return {
            CallExpression(node) {
                const callee = node.callee;

                if (
                    callee.type === "Identifier" &&
                    callee.name === "fetch" &&
                    context.sourceCode.isGlobalReference(callee)
                ) {
                    context.report({
                        node,
                        messageId: "directFetch",
                    });
                    return;
                }

                if (
                    callee.type === "MemberExpression" &&
                    isFetchProperty({
                        computed: callee.computed,
                        property: callee.property,
                    }) &&
                    isGlobalFetchObject(context.sourceCode, callee.object)
                ) {
                    context.report({
                        node,
                        messageId: "directFetch",
                    });
                }
            },
        };
    },
});

export default rule;
