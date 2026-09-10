import * as React from "react";
import {
    Dialog,
    DialogClose,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
} from "@artisann-port/ui/components/dialog";
import {
    Drawer,
    DrawerClose,
    DrawerContent,
    DrawerDescription,
    DrawerFooter,
    DrawerHeader,
    DrawerTitle,
    DrawerTrigger,
} from "@artisann-port/ui/components/drawer";
import { useMediaQuery } from "@artisann-port/ui/hooks/use-media-query";
import { cn } from "@artisann-port/ui/lib/utils";

/** Tailwind's `lg`: a bottom sheet below it, a centred dialog at or above it. */
const DESKTOP_QUERY = "(min-width: 64rem)";

interface ResponsiveDialogClassNames {
    readonly content?: string;
    readonly header?: string;
    readonly title?: string;
    readonly description?: string;
    readonly body?: string;
    readonly footer?: string;
}

interface ResponsiveDialogContextValue {
    readonly isDesktop: boolean;
    readonly classNames: ResponsiveDialogClassNames | undefined;
}

const ResponsiveDialogContext = React.createContext<ResponsiveDialogContextValue | null>(null);

function useResponsiveDialogContext() {
    const context = React.useContext(ResponsiveDialogContext);
    if (context === null) {
        throw new Error(
            "ResponsiveDialog subcomponents must be rendered inside <ResponsiveDialog>",
        );
    }
    return context;
}

export interface ResponsiveDialogProps {
    /** Controlled open state: the shell swaps roots between renders without losing it. */
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
    readonly title: React.ReactNode;
    readonly description?: React.ReactNode;
    /** Control rendered opposite the title, e.g. the close button. */
    readonly headerAction?: React.ReactNode;
    /** The element that opens the dialog or drawer; Base UI merges its trigger props into it. */
    readonly trigger: React.ReactElement;
    /**
     * Places `trigger` inside the page surface that has to stay within the dialog
     * root. Base UI resolves a trigger through its root's React context, so the
     * card that hosts the button is rendered here rather than beside the root.
     */
    readonly triggerHost: (trigger: React.ReactNode) => React.ReactNode;
    readonly children: React.ReactNode;
    /** Class names for the popup itself (the dialog panel or the sheet). */
    readonly className?: string;
    readonly classNames?: ResponsiveDialogClassNames;
}

/**
 * One composer, two surfaces: a bottom-sheet drawer below Tailwind's `lg` and a
 * centred dialog at or above it, sharing the header, body, footer and close
 * control. Open state is owned by the caller so it survives the root swap.
 */
export function ResponsiveDialog({
    open,
    onOpenChange,
    title,
    description,
    headerAction,
    trigger,
    triggerHost,
    children,
    className,
    classNames,
}: ResponsiveDialogProps) {
    const isDesktop = useMediaQuery(DESKTOP_QUERY);

    const body = (
        <>
            {isDesktop ? (
                <DialogHeader className={classNames?.header}>
                    <div className="flex min-h-11 items-center justify-between gap-3">
                        <DialogTitle className={classNames?.title}>{title}</DialogTitle>
                        {headerAction}
                    </div>
                    {description === undefined ? null : (
                        <DialogDescription className={classNames?.description}>
                            {description}
                        </DialogDescription>
                    )}
                </DialogHeader>
            ) : (
                <DrawerHeader className={classNames?.header}>
                    <div className="flex min-h-11 items-center justify-between gap-3">
                        <DrawerTitle className={classNames?.title}>{title}</DrawerTitle>
                        {headerAction}
                    </div>
                    {description === undefined ? null : (
                        <DrawerDescription className={classNames?.description}>
                            {description}
                        </DrawerDescription>
                    )}
                </DrawerHeader>
            )}
            <div className={cn("flex min-h-0 flex-col gap-4", classNames?.body)}>{children}</div>
        </>
    );

    return (
        <ResponsiveDialogContext.Provider value={{ isDesktop, classNames }}>
            {isDesktop ? (
                <Dialog open={open} onOpenChange={onOpenChange}>
                    {triggerHost(<DialogTrigger render={trigger} />)}
                    <DialogContent className={cn(className, classNames?.content)}>
                        {body}
                    </DialogContent>
                </Dialog>
            ) : (
                <Drawer open={open} onOpenChange={onOpenChange}>
                    {triggerHost(<DrawerTrigger render={trigger} />)}
                    <DrawerContent className={cn(className, classNames?.content)}>
                        {body}
                    </DrawerContent>
                </Drawer>
            )}
        </ResponsiveDialogContext.Provider>
    );
}

export function ResponsiveDialogFooter({
    children,
    className,
}: {
    readonly children: React.ReactNode;
    readonly className?: string;
}) {
    const { isDesktop, classNames } = useResponsiveDialogContext();
    const Footer = isDesktop ? DialogFooter : DrawerFooter;
    return <Footer className={cn(className, classNames?.footer)}>{children}</Footer>;
}

export function ResponsiveClose({ children }: { readonly children: React.ReactElement }) {
    const { isDesktop } = useResponsiveDialogContext();
    const Close = isDesktop ? DialogClose : DrawerClose;
    return <Close render={children} />;
}
