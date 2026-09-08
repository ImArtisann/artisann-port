import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description: "Keep Effect Schema validation enabled; fix the data or schema instead.",
        },
        messages: {
            disableValidation:
                "Do not use disableValidation: true. Fix the data or schema and keep validation enabled.",
        },
    },
    create(context) {
        return {
            Property(node: ESTree.ObjectProperty) {
                const isDisableValidationKey =
                    node.key.type === "Identifier" || node.key.type === "PrivateIdentifier"
                        ? node.key.name === "disableValidation"
                        : node.key.type === "Literal" && node.key.value === "disableValidation";
                const value = node.value;

                if (isDisableValidationKey && value.type === "Literal" && value.value === true) {
                    context.report({
                        node,
                        messageId: "disableValidation",
                    });
                }
            },
        };
    },
});

export default rule;
