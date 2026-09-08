import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Avoid Effect.asVoid; return effects whose success type is already void directly.",
        },
        messages: {
            effectAsVoid:
                "Avoid Effect.asVoid. Prefer returning the effect directly when the success type is void.",
        },
    },
    create(context) {
        return {
            MemberExpression(node: ESTree.MemberExpression) {
                if (
                    node.object.type === "Identifier" &&
                    node.object.name === "Effect" &&
                    node.property.type === "Identifier" &&
                    node.property.name === "asVoid"
                ) {
                    context.report({
                        node,
                        messageId: "effectAsVoid",
                    });
                }
            },
        };
    },
});

export default rule;
