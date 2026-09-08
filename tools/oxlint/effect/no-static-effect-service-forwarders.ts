import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type VisitorObject = ReturnType<NonNullable<Rule["create"]>>;
type CallExpressionNode = Parameters<NonNullable<VisitorObject["CallExpression"]>>[0];
type ImportDeclarationNode = Parameters<NonNullable<VisitorObject["ImportDeclaration"]>>[0];
type IdentifierNode = Parameters<NonNullable<VisitorObject["Identifier"]>>[0];
type ExpressionCandidate =
    | CallExpressionNode
    | CallExpressionNode["arguments"][number]
    | CallExpressionNode["callee"]
    | undefined;
type ArrowFunctionExpressionNode = Parameters<
    NonNullable<VisitorObject["ArrowFunctionExpression"]>
>[0];
type FunctionExpressionNode = Parameters<NonNullable<VisitorObject["FunctionExpression"]>>[0];
type CallbackNode = ArrowFunctionExpressionNode | FunctionExpressionNode;

const message =
    "Do not expose an Effect service method through a static forwarder. Yield the service at the usage site and call the method directly.";

const importedName = ({ specifier }: { specifier: ImportDeclarationNode["specifiers"][number] }) =>
    specifier.type === "ImportSpecifier"
        ? specifier.imported.type === "Identifier"
            ? specifier.imported.name
            : specifier.imported.value
        : undefined;

const isStaticClassField = ({ node }: { node: CallExpressionNode }) => {
    let current = node.parent;

    while (current !== null && current !== undefined) {
        if (current.type === "PropertyDefinition") {
            return current.static;
        }

        if (current.type === "Program") {
            return false;
        }

        current = current.parent;
    }

    return false;
};

const callbackExpression = ({ node }: { node: ExpressionCandidate }) => {
    if (node?.type !== "ArrowFunctionExpression" && node?.type !== "FunctionExpression") {
        return undefined;
    }

    const callback: CallbackNode = node;
    const [parameter] = callback.params;
    if (callback.params.length !== 1 || parameter?.type !== "Identifier") {
        return undefined;
    }

    if (callback.body === null) {
        return undefined;
    }

    if (callback.body.type !== "BlockStatement") {
        return {
            expression: callback.body,
            parameterName: parameter.name,
        };
    }

    const [statement] = callback.body.body;
    if (
        callback.body.body.length !== 1 ||
        statement?.type !== "ReturnStatement" ||
        statement.argument === null
    ) {
        return undefined;
    }

    return {
        expression: statement.argument,
        parameterName: parameter.name,
    };
};

const isDirectParameterMember = ({
    expression,
    parameterName,
}: NonNullable<ReturnType<typeof callbackExpression>>) => {
    const member = expression.type === "CallExpression" ? expression.callee : expression;

    return (
        member.type === "MemberExpression" &&
        member.object.type === "Identifier" &&
        member.object.name === parameterName
    );
};

const rule: Rule = {
    meta: {
        type: "problem" as const,
        docs: {
            description:
                "Disallow static Effect service method forwarders; acquire the service where its method is used.",
        },
    },
    create(context) {
        const effectNamespaceNames = new Set<string>();
        const flatMapNames = new Set<string>();
        const serviceNames = new Set<string>();
        const pipeNames = new Set<string>();

        const isImportedIdentifier = ({
            names,
            node,
        }: {
            names: ReadonlySet<string>;
            node: IdentifierNode;
        }) => {
            if (!names.has(node.name)) {
                return false;
            }

            let scope: ReturnType<typeof context.sourceCode.getScope> | null =
                context.sourceCode.getScope(node);

            while (scope !== null) {
                const variable = scope.set.get(node.name);
                if (variable !== undefined) {
                    return variable.defs.some((definition) => definition.type === "ImportBinding");
                }

                scope = scope.upper;
            }

            return false;
        };

        const effectCall = ({
            name,
            names,
            node,
        }: {
            name: "flatMap" | "service";
            names: ReadonlySet<string>;
            node: ExpressionCandidate;
        }): CallExpressionNode | undefined => {
            if (node?.type !== "CallExpression") {
                return undefined;
            }

            if (node.callee.type === "Identifier") {
                return isImportedIdentifier({ names, node: node.callee }) ? node : undefined;
            }

            return node.callee.type === "MemberExpression" &&
                node.callee.object.type === "Identifier" &&
                isImportedIdentifier({
                    names: effectNamespaceNames,
                    node: node.callee.object,
                }) &&
                node.callee.property.type === "Identifier" &&
                node.callee.property.name === name
                ? node
                : undefined;
        };

        const isServiceThisCall = ({ node }: { node: ExpressionCandidate }) => {
            const call = effectCall({ name: "service", names: serviceNames, node });
            return (
                call !== undefined &&
                call.arguments.length === 1 &&
                call.arguments[0]?.type === "ThisExpression"
            );
        };

        const isForwardingFlatMap = ({ node }: { node: ExpressionCandidate }) => {
            const call = effectCall({ name: "flatMap", names: flatMapNames, node });
            if (call === undefined) {
                return false;
            }

            const callback = callbackExpression({ node: call.arguments.at(-1) });
            return callback !== undefined && isDirectParameterMember(callback);
        };

        const isPipeCall = ({ node }: { node: CallExpressionNode }) => {
            if (node.callee.type === "Identifier") {
                return isImportedIdentifier({ names: pipeNames, node: node.callee });
            }

            return (
                node.callee.type === "MemberExpression" &&
                node.callee.property.type === "Identifier" &&
                node.callee.property.name === "pipe"
            );
        };

        return {
            ImportDeclaration(node) {
                if (node.source.value === "effect") {
                    for (const specifier of node.specifiers) {
                        if (
                            specifier.type === "ImportSpecifier" &&
                            importedName({ specifier }) === "Effect"
                        ) {
                            effectNamespaceNames.add(specifier.local.name);
                        }

                        if (
                            specifier.type === "ImportSpecifier" &&
                            importedName({ specifier }) === "pipe"
                        ) {
                            pipeNames.add(specifier.local.name);
                        }
                    }
                    return;
                }

                if (node.source.value !== "effect/Effect") {
                    return;
                }

                for (const specifier of node.specifiers) {
                    if (specifier.type === "ImportNamespaceSpecifier") {
                        effectNamespaceNames.add(specifier.local.name);
                        continue;
                    }

                    const name = importedName({ specifier });
                    if (name === "flatMap") {
                        flatMapNames.add(specifier.local.name);
                    } else if (name === "service") {
                        serviceNames.add(specifier.local.name);
                    }
                }
            },
            CallExpression(node) {
                if (!isStaticClassField({ node })) {
                    return;
                }

                if (
                    effectCall({ name: "flatMap", names: flatMapNames, node }) !== undefined &&
                    node.arguments.length >= 2 &&
                    isServiceThisCall({ node: node.arguments[0] }) &&
                    isForwardingFlatMap({ node })
                ) {
                    context.report({ message, node });
                    return;
                }

                if (!isPipeCall({ node })) {
                    return;
                }

                const pipedEffect =
                    node.callee.type === "MemberExpression"
                        ? node.callee.object
                        : node.arguments[0];
                const operators =
                    node.callee.type === "MemberExpression"
                        ? node.arguments
                        : node.arguments.slice(1);

                if (
                    isServiceThisCall({ node: pipedEffect }) &&
                    operators.some((operator) => isForwardingFlatMap({ node: operator }))
                ) {
                    context.report({ message, node });
                }
            },
        };
    },
};

export default rule;
