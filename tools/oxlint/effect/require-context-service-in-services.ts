import type { RuleTester } from "oxlint/plugins-dev";

type Rule = Parameters<RuleTester["run"]>[1];
type VisitorObject = ReturnType<NonNullable<Rule["create"]>>;
type ClassDeclarationNode = Parameters<NonNullable<VisitorObject["ClassDeclaration"]>>[0];
type ClassExpressionNode = Parameters<NonNullable<VisitorObject["ClassExpression"]>>[0];
type ServiceSuperClass = NonNullable<ClassDeclarationNode["superClass"]>;

const isStringArray = (value: unknown): value is Array<string> =>
    Array.isArray(value) &&
    value.every((entry: unknown): entry is string => typeof entry === "string");

const isContextService = ({ node }: { node: ServiceSuperClass | null }): boolean => {
    if (node === null) {
        return false;
    }

    if (node.type === "MemberExpression") {
        return (
            node.object.type === "Identifier" &&
            node.object.name === "Context" &&
            node.property.type === "Identifier" &&
            node.property.name === "Service"
        );
    }

    if (node.type === "CallExpression") {
        return isContextService({ node: node.callee });
    }

    if (
        node.type === "ChainExpression" ||
        node.type === "ParenthesizedExpression" ||
        node.type === "TSInstantiationExpression"
    ) {
        return isContextService({ node: node.expression });
    }

    return false;
};

const rule: Rule = {
    meta: {
        type: "problem" as const,
        docs: {
            description:
                "Require production modules in services folders to define a class extending Context.Service.",
        },
        schema: [
            {
                type: "object",
                properties: {
                    ignoredBasenames: {
                        type: "array",
                        items: { type: "string" },
                    },
                    ignoredDirectoryNames: {
                        type: "array",
                        items: { type: "string" },
                    },
                    serviceDirectoryNames: {
                        type: "array",
                        items: { type: "string" },
                    },
                },
                additionalProperties: false,
            },
        ],
    },
    create(context) {
        const rawOptions = context.options[0];
        const options =
            rawOptions !== null && typeof rawOptions === "object" && !Array.isArray(rawOptions)
                ? rawOptions
                : null;
        const getStringArrayOption = (name: string) => {
            const value = options?.[name];
            return isStringArray(value) ? value : undefined;
        };
        const ignoredBasenames = new Set(
            getStringArrayOption("ignoredBasenames") ?? ["index.ts", "main.ts"],
        );
        const ignoredDirectoryNames = new Set(
            getStringArrayOption("ignoredDirectoryNames") ?? ["test", "tests", "__tests__"],
        );
        const serviceDirectoryNames = new Set(
            getStringArrayOption("serviceDirectoryNames") ?? ["service", "services"],
        );
        const filename = (context.filename ?? "").replaceAll("\\", "/");
        const basename = filename.slice(filename.lastIndexOf("/") + 1);
        const segments = filename.split("/");

        if (
            (!filename.endsWith(".ts") && !filename.endsWith(".tsx")) ||
            filename.endsWith(".d.ts") ||
            !segments.some((segment) => serviceDirectoryNames.has(segment)) ||
            segments.some((segment) => ignoredDirectoryNames.has(segment)) ||
            basename.endsWith(".test.ts") ||
            basename.endsWith(".test.tsx") ||
            basename.endsWith(".spec.ts") ||
            basename.endsWith(".spec.tsx") ||
            ignoredBasenames.has(basename)
        ) {
            return {};
        }

        let definesContextService = false;
        let hasClassImplementation = false;

        return {
            ClassDeclaration(node: ClassDeclarationNode) {
                hasClassImplementation = true;
                if (
                    isContextService({
                        node: node.superClass,
                    })
                ) {
                    definesContextService = true;
                }
            },
            ClassExpression(node: ClassExpressionNode) {
                hasClassImplementation = true;
                if (isContextService({ node: node.superClass })) {
                    definesContextService = true;
                }
            },
            "Program:exit"(node) {
                if (!hasClassImplementation || definesContextService) {
                    return;
                }

                context.report({
                    node,
                    message:
                        "Files inside services folders must define a class extending Context.Service.",
                });
            },
        };
    },
};

export default rule;
