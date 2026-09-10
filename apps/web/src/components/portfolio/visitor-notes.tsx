/** @jsxImportSource react */
import { useId, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
    Cancel01Icon,
    ChevronLeftIcon,
    ChevronRightIcon,
    PlusSignIcon,
} from "@hugeicons-pro/core-solid-rounded";
import { Button } from "@artisann-port/ui/components/button";
import {
    Card,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@artisann-port/ui/components/card";
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
import { Field, FieldGroup, FieldLabel } from "@artisann-port/ui/components/field";
import { Input } from "@artisann-port/ui/components/input";
import { Textarea } from "@artisann-port/ui/components/textarea";

const NOTE_LIMIT = 120;

/** Design-only guestbook: drafts stay in component memory and cannot be published. */
export function VisitorNotes() {
    const id = useId();
    const [name, setName] = useState("");
    const [note, setNote] = useState("");
    const nameId = `${id}-name`;
    const noteId = `${id}-note`;
    const countId = `${id}-count`;
    const unavailableId = `${id}-unavailable`;

    return (
        <Dialog>
            <Card
                variant="note"
                role="region"
                aria-labelledby={`${id}-heading`}
                data-portfolio-section="visitor-notes"
                className="relative min-h-52.25 gap-3 overflow-hidden"
            >
                <span
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0 right-0 size-5 bg-note-fold [clip-path:polygon(0_0,100%_100%,0_100%)]"
                />
                <CardHeader className="flex flex-1 flex-col gap-2">
                    <CardTitle tone="heading">
                        <h2 id={`${id}-heading`}>Leave a little note.</h2>
                    </CardTitle>
                    <CardDescription>
                        A thought, a hello, or something kind.
                        <br />
                        Be the first to leave one.
                    </CardDescription>
                </CardHeader>
                <CardFooter className="flex-wrap justify-between gap-2">
                    <DialogTrigger render={<Button variant="ghost" className="h-11 gap-2 px-1" />}>
                        <HugeiconsIcon
                            icon={PlusSignIcon}
                            data-icon="inline-start"
                            aria-hidden="true"
                        />
                        Add a note
                    </DialogTrigger>
                    <div className="ml-auto flex gap-1" role="group" aria-label="Notes carousel">
                        <Button
                            variant="ghost"
                            size="icon-carousel"
                            className="size-11 lg:size-11"
                            disabled
                            aria-label="Previous note"
                            title="No notes yet"
                        >
                            <HugeiconsIcon icon={ChevronLeftIcon} aria-hidden="true" />
                        </Button>
                        <Button
                            variant="ghost"
                            size="icon-carousel"
                            className="size-11 lg:size-11"
                            disabled
                            aria-label="Next note"
                            title="No notes yet"
                        >
                            <HugeiconsIcon icon={ChevronRightIcon} aria-hidden="true" />
                        </Button>
                    </div>
                </CardFooter>
            </Card>
            <DialogContent showCloseButton={false}>
                <DialogHeader>
                    <div className="flex min-h-11 items-center justify-between gap-3">
                        <DialogTitle>Add a note</DialogTitle>
                        <DialogClose
                            render={
                                <Button
                                    variant="ghost"
                                    size="icon-carousel"
                                    className="size-11 lg:size-11"
                                    aria-label="Close note dialog"
                                />
                            }
                        >
                            <HugeiconsIcon icon={Cancel01Icon} aria-hidden="true" />
                        </DialogClose>
                    </div>
                    <DialogDescription id={unavailableId}>
                        Posting is not available yet. This preview does not publish or save your
                        note.
                    </DialogDescription>
                </DialogHeader>
                <FieldGroup>
                    <Field>
                        <FieldLabel htmlFor={nameId}>Name (optional)</FieldLabel>
                        <Input
                            id={nameId}
                            autoComplete="nickname"
                            placeholder="How should your note be signed?"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                        />
                    </Field>
                    <Field>
                        <div className="flex items-center justify-between gap-3">
                            <FieldLabel htmlFor={noteId}>Your note</FieldLabel>
                            <span
                                id={countId}
                                className="text-sm text-muted-foreground"
                                aria-live="polite"
                                aria-atomic="true"
                            >
                                {note.length} / {NOTE_LIMIT}
                            </span>
                        </div>
                        <Textarea
                            id={noteId}
                            className="h-33 resize-none"
                            placeholder="Leave a thought or say hello…"
                            maxLength={NOTE_LIMIT}
                            value={note}
                            onChange={(event) => setNote(event.target.value)}
                            aria-describedby={`${countId} ${unavailableId}`}
                        />
                    </Field>
                </FieldGroup>
                <p className="text-sm/5 text-muted-foreground">
                    Your note will be public. Please keep it kind.
                </p>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="secondary"
                        className="h-11 w-full"
                        disabled
                        aria-describedby={unavailableId}
                    >
                        Post note
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
