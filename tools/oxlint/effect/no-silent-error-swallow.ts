import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type VisitorObject = ReturnType<NonNullable<Rule["create"]>>;
type CallExpressionNode = Parameters<NonNullable<VisitorObject["CallExpression"]>>[0];
type ExpressionNode = CallExpressionNode["callee"] | CallExpressionNode["arguments"][number];

const message =
    "Do not silently swallow Effect errors with Effect.void or Effect.unit. Recover meaningfully, transform the error, or let it propagate.";

const isEffectMember = ({
    methodKind,
    node,
}: {
    methodKind: "catch" | "voidOrUnit";
    node: ExpressionNode | null;
}) => {
    if (
        node === null ||
        node.type !== "MemberExpression" ||
        node.object.type !== "Identifier" ||
        node.property.type !== "Identifier" ||
        node.object.name !== "Effect"
    ) {
        return false;
    }

    return methodKind === "voidOrUnit"
        ? node.property.name === "void" || node.property.name === "unit"
        : node.property.name === "catch" ||
              node.property.name === "catchTag" ||
              node.property.name === "catchTags" ||
              node.property.name === "catchReason" ||
              node.property.name === "catchReasons" ||
              node.property.name === "catchCause" ||
              node.property.name === "catchDefect" ||
              node.property.name === "catchIf" ||
              node.property.name === "catchFilter" ||
              node.property.name === "catchCauseIf" ||
              node.property.name === "catchCauseFilter" ||
              node.property.name === "catchEager";
};

const isEffectVoidOrUnit = ({ node }: { node: ExpressionNode | null }) =>
    isEffectMember({ methodKind: "voidOrUnit", node });

const returnsOnlyVoid = ({ node }: { node: ExpressionNode }) => {
    if (node.type !== "ArrowFunctionExpression" && node.type !== "FunctionExpression") {
        return false;
    }

    if (
        node.body !== null &&
        node.body.type !== "BlockStatement" &&
        isEffectVoidOrUnit({ node: node.body })
    ) {
        return true;
    }

    if (node.body === null || node.body.type !== "BlockStatement") {
        return false;
    }

    const [statement] = node.body.body;

    return (
        node.body.body.length === 1 &&
        statement?.type === "ReturnStatement" &&
        isEffectVoidOrUnit({ node: statement.argument })
    );
};

const rule: Rule = {
    meta: {
        type: "problem" as const,
        docs: {
            description:
                "Do not silently swallow Effect errors; recover, transform, or propagate them.",
        },
    },
    create(context) {
        return {
            CallExpression(node) {
                if (
                    !isEffectMember({
                        methodKind: "catch",
                        node: node.callee,
                    })
                ) {
                    return;
                }

                for (const argument of node.arguments) {
                    if (returnsOnlyVoid({ node: argument })) {
                        context.report({
                            node,
                            message,
                        });
                    }

                    if (argument.type !== "ObjectExpression") {
                        continue;
                    }

                    for (const property of argument.properties) {
                        if (
                            property.type === "Property" &&
                            returnsOnlyVoid({ node: property.value })
                        ) {
                            context.report({
                                node,
                                message,
                            });
                        }
                    }
                }
            },
        };
    },
};

export default rule;
