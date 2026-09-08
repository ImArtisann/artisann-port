import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";

const provisioningMethods = {
    provide: true,
    provideMerge: true,
} as const;

const findImportDefinition = ({
    node,
    sourceCode,
}: {
    node: ESTree.IdentifierReference;
    sourceCode: SourceCode;
}) => {
    let scope: Scope | null = sourceCode.getScope(node);

    while (scope !== null) {
        const variable = scope.set.get(node.name);

        if (variable !== undefined) {
            return variable.defs.find(
                (definition) =>
                    definition.type === "ImportBinding" &&
                    definition.parent?.type === "ImportDeclaration",
            );
        }

        scope = scope.upper;
    }

    return undefined;
};

const isEffectLayerIdentifier = ({
    node,
    sourceCode,
}: {
    node: ESTree.IdentifierReference;
    sourceCode: SourceCode;
}) => {
    const definition = findImportDefinition({ node, sourceCode });
    const parent = definition?.parent;
    const source = parent?.type === "ImportDeclaration" ? parent.source.value : undefined;

    if (source === "effect/Layer" && definition?.node.type === "ImportNamespaceSpecifier") {
        return true;
    }

    return (
        source === "effect" &&
        definition?.node.type === "ImportSpecifier" &&
        (definition.node.imported.type === "Identifier"
            ? definition.node.imported.name
            : definition.node.imported.value) === "Layer"
    );
};

const isLayerProvision = (
    node: ESTree.Argument,
    sourceCode: SourceCode,
): node is ESTree.CallExpression => {
    if (
        node.type !== "CallExpression" ||
        node.callee.type !== "MemberExpression" ||
        node.callee.object.type !== "Identifier" ||
        !isEffectLayerIdentifier({ node: node.callee.object, sourceCode })
    ) {
        return false;
    }

    const property = node.callee.property;
    return property.type === "Identifier"
        ? Object.hasOwn(provisioningMethods, property.name)
        : property.type === "Literal" &&
              (property.value === "provide" || property.value === "provideMerge");
};

const isLayerPipeReceiver = ({
    node,
    sourceCode,
}: {
    node: ESTree.Expression;
    sourceCode: SourceCode;
}) => {
    if (
        node.type === "CallExpression" &&
        node.callee.type === "MemberExpression" &&
        node.callee.object.type === "Identifier" &&
        isEffectLayerIdentifier({ node: node.callee.object, sourceCode })
    ) {
        return true;
    }

    if (
        node.type === "ChainExpression" ||
        node.type === "ParenthesizedExpression" ||
        node.type === "TSAsExpression" ||
        node.type === "TSTypeAssertion" ||
        node.type === "TSInstantiationExpression" ||
        node.type === "TSNonNullExpression"
    ) {
        return isLayerPipeReceiver({ node: node.expression, sourceCode });
    }

    return false;
};

const rule = defineRule({
    meta: {
        type: "problem",
        docs: {
            description:
                "Combine independent Layer dependencies in one provide call and extract intentional dependency stages.",
        },
        messages: {
            multipleProvisioningStages:
                "Avoid multiple Layer.provide or Layer.provideMerge stages in one pipe. Combine independent dependencies in one Layer.provide([...]); when a layer depends on another layer, extract and name that configured layer before providing it.",
        },
    },
    create(context) {
        return {
            CallExpression(node) {
                if (
                    node.callee.type !== "MemberExpression" ||
                    node.callee.property.type !== "Identifier" ||
                    node.callee.property.name !== "pipe"
                ) {
                    return;
                }
                if (
                    node.callee.object.type === "Super" ||
                    !isLayerPipeReceiver({
                        node: node.callee.object,
                        sourceCode: context.sourceCode,
                    })
                ) {
                    return;
                }

                const provisioningStages = node.arguments.filter((argument) =>
                    isLayerProvision(argument, context.sourceCode),
                );

                if (provisioningStages.length < 2) {
                    return;
                }

                context.report({
                    node,
                    messageId: "multipleProvisioningStages",
                });
            },
        };
    },
});

export default rule;
