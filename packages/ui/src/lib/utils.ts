import { createCn } from "cn/config";

export const cn = createCn({
    extend: {
        classGroups: {
            "font-size": [
                {
                    text: [
                        "aside",
                        "caption",
                        "image-caption",
                        "label",
                        "heading",
                        "subheading",
                        "wordmark",
                        "title",
                        "project",
                        "display",
                    ],
                },
            ],
        },
    },
});
