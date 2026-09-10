import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { DiscordREST, Ix } from "dfx";
import { MessageComponentData } from "dfx/Interactions/context";
import type * as Discord from "dfx/types";
import { EntryId, type VisitorNote } from "@artisann-port/presence/content";
import { escapeNoteText } from "@artisann-port/presence/notes";
import { BotConfig } from "./config.ts";
import { BotContentClient } from "./content-client.ts";
import {
    asJob,
    authorizeOwner,
    deferredComponentAck,
    deferredEphemeralAck,
    ephemeralResponse,
    PRIVATE_BOT_MESSAGE,
    queueJob,
} from "./interaction-jobs.ts";

const isNoteId = Schema.is(EntryId);

type NotesAction = "list" | "prev" | "next" | "delete";

/** Stable note ids keep an old browser from deleting a different note after a refresh. */
const renderNotes = (
    notes: readonly VisitorNote[],
    index: number,
    notice: string,
): Discord.IncomingWebhookUpdateRequestPartial => {
    const activeIndex = Math.max(0, Math.min(index, notes.length - 1));
    const note = notes[activeIndex];
    if (note === undefined) {
        return {
            content: [notice, "There are no approved notes."].filter(Boolean).join("\n"),
            embeds: [],
            components: [],
            allowed_mentions: { parse: [] },
        };
    }
    return {
        content: notice,
        embeds: [
            {
                title: `Approved note ${activeIndex + 1} of ${notes.length}`,
                description: escapeNoteText(note.body),
                fields: [
                    { name: "From", value: escapeNoteText(note.name ?? "Anonymous") },
                    { name: "ID", value: note.id },
                    { name: "Submitted", value: note.submittedAt },
                ],
            },
        ],
        components: [
            {
                type: 1,
                components: [
                    {
                        type: 2,
                        style: 2,
                        label: "Previous",
                        custom_id: `notes:prev:${note.id}`,
                        disabled: activeIndex === 0,
                    },
                    {
                        type: 2,
                        style: 2,
                        label: "Next",
                        custom_id: `notes:next:${note.id}`,
                        disabled: activeIndex === notes.length - 1,
                    },
                    {
                        type: 2,
                        style: 4,
                        label: "Delete",
                        custom_id: `notes:delete:${note.id}`,
                    },
                ],
            },
        ],
        allowed_mentions: { parse: [] },
    };
};

const notesFlow = Effect.fn("Notes.browserFlow")(function* (
    interaction: Discord.APIInteraction,
    action: NotesAction,
    id: string | null,
    component: boolean,
) {
    const config = yield* BotConfig;
    const client = yield* BotContentClient;
    const rest = yield* DiscordREST;
    const reporter = { rest, clientId: config.clientId };
    yield* queueJob(
        asJob(
            reporter,
            interaction,
            Effect.gen(function* () {
                let notes = (yield* client.loadContent).notes;
                let index = id === null ? 0 : notes.findIndex((note) => note.id === id);
                let notice = "";
                if (action === "delete" && id !== null) {
                    const outcome = yield* client.deleteNote(id);
                    notice =
                        outcome === "deleted"
                            ? `Deleted note ${id}.`
                            : "That note no longer exists.";
                    notes = (yield* client.loadContent).notes;
                } else if (index === -1) {
                    notice = "The notes changed — showing the first approved note.";
                } else if (action === "prev" || action === "next") {
                    index += action === "prev" ? -1 : 1;
                }
                yield* rest.updateOriginalWebhookMessage(config.clientId, interaction.token, {
                    payload: renderNotes(notes, index, notice),
                });
            }),
        ),
    );
    return component ? deferredComponentAck : deferredEphemeralAck;
});

export const browseNotesFlow = (interaction: Discord.APIInteraction) =>
    notesFlow(interaction, "list", null, false);

export const deleteNoteFlow = (interaction: Discord.APIInteraction, id: string) =>
    isNoteId(id)
        ? notesFlow(interaction, "delete", id, false)
        : Effect.succeed(ephemeralResponse("That note id is invalid."));

export const handleNotesComponent = Effect.gen(function* () {
    if (!(yield* authorizeOwner)) return ephemeralResponse(PRIVATE_BOT_MESSAGE);
    const interaction = yield* Ix.Interaction;
    const data = yield* MessageComponentData;
    const match = /^notes:(prev|next|delete):([a-z0-9-]{1,32})$/u.exec(data.custom_id);
    const action = match?.[1];
    const id = match?.[2];
    if (
        (action !== "prev" && action !== "next" && action !== "delete") ||
        id === undefined ||
        !isNoteId(id)
    ) {
        return ephemeralResponse("Unknown notes action.");
    }
    return yield* notesFlow(interaction, action, id, true);
});
