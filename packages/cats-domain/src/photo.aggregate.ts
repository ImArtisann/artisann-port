import * as Domain from "@alchemy.run/domain";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { PhotoKey } from "./photo.id.ts";
import { HeartPhoto, HeartRecorded } from "./heart-photo.command.ts";
import {
    AcceptComment,
    CommentAccepted,
    InvalidComment,
    StoredComment,
} from "./accept-comment.command.ts";
import { ImportPhotoFact, ImportConflict } from "./import-photo-fact.command.ts";
export const PhotoState = Schema.Struct({
    hearts: Schema.Record(Schema.String, Schema.String),
    likes: Schema.Int,
    comments: Schema.Array(StoredComment),
    nextCommentId: Schema.Int,
});
export class Photo extends Domain.Aggregate("Photo", {
    id: PhotoKey,
    state: PhotoState,
    initial: { hearts: {}, likes: 0, comments: [], nextCommentId: 1 },
    commands: [HeartPhoto, AcceptComment, ImportPhotoFact],
    decide: {
        HeartPhoto: (state, command, { now }) =>
            state.hearts[command.visitorId] !== undefined
                ? []
                : [
                      new HeartRecorded({
                          visitorId: command.visitorId,
                          createdAt: DateTime.formatIso(now),
                          likesAfter: state.likes + 1,
                      }),
                  ],
        AcceptComment: (state, command, { now }) => {
            const body = command.body.trim();
            if (body.length === 0 || body.length > 280) return new InvalidComment();
            return [
                new CommentAccepted({
                    comment: {
                        id: state.nextCommentId,
                        visitorId: command.visitorId,
                        body,
                        createdAt: DateTime.formatIso(now),
                    },
                }),
            ];
        },
        ImportPhotoFact: (state, command) => {
            if (command.kind === "heart") {
                if (command.commentId !== null || command.body !== null)
                    return new ImportConflict();
                const existing = state.hearts[command.visitorId];
                if (existing !== undefined)
                    return existing === command.createdAt ? [] : new ImportConflict();
                return [
                    new HeartRecorded({
                        visitorId: command.visitorId,
                        createdAt: command.createdAt,
                        likesAfter: state.likes + 1,
                    }),
                ];
            }
            if (
                command.commentId === null ||
                command.commentId < 1 ||
                command.body === null ||
                command.body.length === 0 ||
                command.body.length > 280
            )
                return new ImportConflict();
            const existing = state.comments.find((comment) => comment.id === command.commentId);
            if (existing !== undefined)
                return existing.visitorId === command.visitorId &&
                    existing.createdAt === command.createdAt &&
                    existing.body === command.body
                    ? []
                    : new ImportConflict();
            return [
                new CommentAccepted({
                    comment: {
                        id: command.commentId,
                        visitorId: command.visitorId,
                        body: command.body,
                        createdAt: command.createdAt,
                    },
                }),
            ];
        },
    },
    evolve: {
        HeartRecorded: (state, event) => ({
            ...state,
            hearts: { ...state.hearts, [event.visitorId]: event.createdAt },
            likes: event.likesAfter,
        }),
        CommentAccepted: (state, event) => ({
            ...state,
            comments: [...state.comments, event.comment],
            nextCommentId: Math.max(state.nextCommentId, event.comment.id + 1),
        }),
    },
    reply: {
        HeartPhoto: (state) => ({ likes: state.likes }),
        AcceptComment: (_state, events) => ({
            comment: events.find((event) => event._tag === "CommentAccepted")?.comment ?? null,
        }),
    },
    read: {},
}) {}
