import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const isLayerProvide = (node: ESTree.Argument): node is ESTree.CallExpression => {
    if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression" ||
        node.callee.object.type !== "Identifier" ||
        node.callee.property.type !== "Identifier" ||
        node.callee.object.name !== "Layer"
    ) {
        return false;
    }

    return node.callee.property.name === "provide" || node.callee.property.name === "provideMerge";
};

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Avoid nested Layer.provide or Layer.provideMerge calls; extract the inner layer before provisioning it.",
        },
        messages: {
            nestedProvision:
                "Avoid nested Layer.provide or Layer.provideMerge calls. Extract the inner layer before provisioning it.",
        },
    },
    create(context) {
        return {
            CallExpression(node) {
                if (!isLayerProvide(node)) {
                    return;
                }

                for (const argument of node.arguments) {
                    if (isLayerProvide(argument)) {
                        context.report({
                            node: argument,
                            messageId: "nestedProvision",
                        });
                    }
                }
            },
        };
    },
});

export default rule;
