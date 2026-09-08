import type { ESTree, Scope, SourceCode } from "@oxlint/plugins";
import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];

const message =
    "Do not use Effect.serviceOption. Require the service directly and provide it in the layer.";

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

type ImportSourceValue = ESTree.ImportDeclaration["source"]["value"];

const isEffectModule = (source: ImportSourceValue) =>
    source === "effect" || source === "effect/Effect";

const isEffectNamespaceModule = (source: ImportSourceValue) => source === "effect/Effect";

const isImportedServiceOption = ({
    node,
    sourceCode,
}: {
    node: ESTree.IdentifierReference;
    sourceCode: SourceCode;
}) => {
    const definition = findImportDefinition({ node, sourceCode });
    return (
        definition?.parent?.type === "ImportDeclaration" &&
        isEffectModule(definition.parent.source.value) &&
        definition.node.type === "ImportSpecifier" &&
        (definition.node.imported.type === "Identifier"
            ? definition.node.imported.name
            : definition.node.imported.value) === "serviceOption"
    );
};

const isImportedEffectNamespace = ({
    node,
    sourceCode,
}: {
    node: ESTree.IdentifierReference;
    sourceCode: SourceCode;
}) => {
    const definition = findImportDefinition({ node, sourceCode });
    return (
        definition?.parent?.type === "ImportDeclaration" &&
        isEffectNamespaceModule(definition.parent.source.value) &&
        definition.node.type === "ImportNamespaceSpecifier"
    );
};

const rule: Rule = {
    meta: {
        type: "problem" as const,
        docs: {
            description:
                "Avoid Effect.serviceOption; require the service directly and provide it in the layer.",
        },
    },
    create(context) {
        return {
            CallExpression(node) {
                const callee = node.callee;

                if (
                    callee.type === "Identifier" &&
                    isImportedServiceOption({ node: callee, sourceCode: context.sourceCode })
                ) {
                    context.report({
                        node,
                        message,
                    });
                }
            },
            MemberExpression(node) {
                if (
                    node.object.type !== "Identifier" ||
                    !isImportedEffectNamespace({
                        node: node.object,
                        sourceCode: context.sourceCode,
                    }) ||
                    !(
                        (node.property.type === "Identifier" &&
                            node.property.name === "serviceOption") ||
                        (node.property.type === "Literal" &&
                            node.property.value === "serviceOption")
                    )
                ) {
                    return;
                }

                context.report({
                    node,
                    message,
                });
            },
        };
    },
};

export default rule;
