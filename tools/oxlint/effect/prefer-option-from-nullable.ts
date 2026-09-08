import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type VisitorObject = ReturnType<NonNullable<Rule["create"]>>;
type ConditionalExpressionNode = Parameters<NonNullable<VisitorObject["ConditionalExpression"]>>[0];
type BinaryExpressionNode = Extract<
    ConditionalExpressionNode["test"],
    { type: "BinaryExpression" }
>;
type ExpressionNode = ConditionalExpressionNode["consequent"];

const isNullLiteral = (node: BinaryExpressionNode["left"]) =>
    node.type === "Literal" && node.value === null && node.raw === "null";

const getOptionMemberCall = ({ name, node }: { name: string; node: ExpressionNode }) => {
    if (node.type !== "CallExpression") {
        return undefined;
    }

    const member =
        node.callee.type === "MemberExpression"
            ? node.callee
            : node.callee.type === "TSInstantiationExpression" &&
                node.callee.expression.type === "MemberExpression"
              ? node.callee.expression
              : undefined;

    return member !== undefined &&
        member.object.type === "Identifier" &&
        member.object.name === "Option" &&
        member.property.type === "Identifier" &&
        member.property.name === name
        ? node
        : undefined;
};

const rule: Rule = {
    meta: {
        type: "problem" as const,
        docs: {
            description:
                "Use Option.fromNullable instead of ternaries that choose between Option.some and Option.none.",
        },
    },
    create(context) {
        return {
            ConditionalExpression(node) {
                if (
                    node.test.type !== "BinaryExpression" ||
                    (node.test.operator !== "!==" && node.test.operator !== "!=") ||
                    (!isNullLiteral(node.test.left) && !isNullLiteral(node.test.right))
                ) {
                    return;
                }

                const nullableOperand = isNullLiteral(node.test.left)
                    ? node.test.right
                    : node.test.left;
                if (isNullLiteral(nullableOperand)) {
                    return;
                }

                const someCall = getOptionMemberCall({ name: "some", node: node.consequent });
                const noneCall = getOptionMemberCall({ name: "none", node: node.alternate });
                const someArguments = someCall?.arguments;
                if (
                    noneCall === undefined ||
                    someArguments === undefined ||
                    someArguments.length !== 1
                ) {
                    return;
                }

                const [someArgument] = someArguments;
                if (
                    someArgument === undefined ||
                    someArgument.type === "SpreadElement" ||
                    context.sourceCode.getText(nullableOperand) !==
                        context.sourceCode.getText(someArgument)
                ) {
                    return;
                }

                context.report({
                    node,
                    message:
                        "Use Option.fromNullable instead of a nullable ternary with Option.some and Option.none.",
                });
            },
        };
    },
};

export default rule;
