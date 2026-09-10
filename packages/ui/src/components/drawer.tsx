import * as React from "react";
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import { cn } from "@artisann-port/ui/lib/utils";

import { Button } from "@artisann-port/ui/components/button";

function Drawer({ ...props }: DrawerPrimitive.Root.Props) {
    return <DrawerPrimitive.Root data-slot="drawer" swipeDirection="down" {...props} />;
}

function DrawerTrigger({ ...props }: DrawerPrimitive.Trigger.Props) {
    return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />;
}

function DrawerPortal({ ...props }: DrawerPrimitive.Portal.Props) {
    return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />;
}

function DrawerClose({ ...props }: DrawerPrimitive.Close.Props) {
    return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

function DrawerBackdrop({ className, ...props }: DrawerPrimitive.Backdrop.Props) {
    return (
        <DrawerPrimitive.Backdrop
            data-slot="drawer-backdrop"
            className={cn(
                "fixed inset-0 z-50 min-h-dvh bg-black/50 opacity-[calc(1-var(--drawer-swipe-progress))] transition-opacity duration-300 ease-out data-swiping:duration-0 data-starting-style:opacity-0 data-ending-style:opacity-0",
                className,
            )}
            {...props}
        />
    );
}

/**
 * The bottom sheet: a modal frame anchored to the viewport bottom that follows
 * the drag (`--drawer-swipe-movement-y`) and dismisses on a downward swipe.
 * The viewport ignores pointer events so presses outside the sheet reach the
 * backdrop; the popup re-enables them for its own frame.
 */
function DrawerContent({ className, children, ...props }: DrawerPrimitive.Popup.Props) {
    return (
        <DrawerPortal>
            <DrawerBackdrop />
            <DrawerPrimitive.Viewport className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center">
                <DrawerPrimitive.Popup
                    data-slot="drawer-content"
                    className={cn(
                        "pointer-events-auto flex max-h-[85dvh] w-full flex-col overflow-y-auto overscroll-contain rounded-t-xl bg-popover px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] text-sm text-popover-foreground ring-1 ring-border outline-none [transform:translateY(var(--drawer-swipe-movement-y))] transition-transform duration-300 ease-out data-swiping:select-none data-starting-style:[transform:translateY(calc(100%+2px))] data-ending-style:[transform:translateY(calc(100%+2px))]",
                        className,
                    )}
                    {...props}
                >
                    <div
                        aria-hidden="true"
                        className="mx-auto mb-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30"
                    />
                    <DrawerPrimitive.Content className="flex min-h-0 flex-col">
                        {children}
                    </DrawerPrimitive.Content>
                </DrawerPrimitive.Popup>
            </DrawerPrimitive.Viewport>
        </DrawerPortal>
    );
}

function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
    return (
        <div
            data-slot="drawer-header"
            className={cn("flex flex-col gap-2", className)}
            {...props}
        />
    );
}

function DrawerFooter({
    className,
    showCloseButton = false,
    children,
    ...props
}: React.ComponentProps<"div"> & {
    showCloseButton?: boolean;
}) {
    return (
        <div
            data-slot="drawer-footer"
            className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
            {...props}
        >
            {children}
            {showCloseButton && (
                <DrawerPrimitive.Close render={<Button variant="outline" />}>
                    Close
                </DrawerPrimitive.Close>
            )}
        </div>
    );
}

function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props) {
    return (
        <DrawerPrimitive.Title
            data-slot="drawer-title"
            className={cn("font-heading text-xl leading-[1.3] font-semibold", className)}
            {...props}
        />
    );
}

function DrawerDescription({ className, ...props }: DrawerPrimitive.Description.Props) {
    return (
        <DrawerPrimitive.Description
            data-slot="drawer-description"
            className={cn(
                "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
                className,
            )}
            {...props}
        />
    );
}

export {
    Drawer,
    DrawerBackdrop,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerHeader,
    DrawerPortal,
    DrawerTitle,
    DrawerTrigger,
};
