import * as React from "react";
import { cn } from "@artisann-port/ui/lib/utils";

function Card({
    className,
    size = "default",
    variant = "default",
    ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm"; variant?: "default" | "note" }) {
    return (
        <div
            data-slot="card"
            data-size={size}
            data-variant={variant}
            className={cn(
                "group/card flex min-w-0 flex-col gap-(--card-spacing) rounded-xl py-(--card-spacing) text-sm [--card-spacing:--spacing(6)] has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(4)] *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
                variant === "note"
                    ? "bg-note text-note-foreground [--card-spacing:--spacing(5)]"
                    : "bg-card text-card-foreground inset-ring inset-ring-border",
                className,
            )}
            {...props}
        />
    );
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-header"
            className={cn(
                "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
                className,
            )}
            {...props}
        />
    );
}

function CardTitle({
    className,
    tone = "title",
    ...props
}: React.ComponentProps<"div"> & { tone?: "title" | "heading" | "label" }) {
    return (
        <div
            data-slot="card-title"
            className={cn(
                "font-heading",
                tone === "title" && "text-title font-semibold tracking-[-0.02em]",
                tone === "heading" && "text-heading font-semibold",
                tone === "label" && "text-caption text-muted-foreground",
                "group-data-[variant=note]/card:text-xl group-data-[variant=note]/card:leading-[1.3]",
                className,
            )}
            {...props}
        />
    );
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-description"
            className={cn(
                "text-caption text-muted-foreground group-data-[variant=note]/card:text-sm/5 group-data-[variant=note]/card:text-note-muted-foreground",
                className,
            )}
            {...props}
        />
    );
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-action"
            className={cn(
                "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
                className,
            )}
            {...props}
        />
    );
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div data-slot="card-content" className={cn("px-(--card-spacing)", className)} {...props} />
    );
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="card-footer"
            className={cn("flex items-center px-(--card-spacing)", className)}
            {...props}
        />
    );
}

export { Card, CardHeader, CardFooter, CardTitle, CardAction, CardDescription, CardContent };
