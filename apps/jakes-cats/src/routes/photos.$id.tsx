import { useState } from "react";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import {
    MAX_COMMENT_LENGTH,
    MAX_COMMENTS_PER_PHOTO,
    PhotoInput,
    SITE_URL,
    photoPagePath,
    type PhotoComment,
    type PhotoDetail,
} from "../contracts.ts";
import { HeartButton } from "../components/heart-button.tsx";
import { HeartCount } from "../components/heart-count.tsx";
import { relativeTime } from "../components/relative-time.ts";
import { Toast } from "../components/toast.tsx";
import { failureMessage } from "../components/toast-message.ts";
import { addComment, getPhoto, likePhoto } from "../server-fns.ts";

export const Route = createFileRoute("/photos/$id")({
    loader: ({ params }) => {
        const input = { id: params.id };
        // An id outside the managed grammar is not a missing cat, it is not a
        // cat page at all: refuse it here so the strict decoder never throws a
        // SchemaError at the browser.
        if (!Schema.is(PhotoInput)(input)) throw notFound();
        return getPhoto({ data: input });
    },
    component: PhotoPage,
    notFoundComponent: CatNotFound,
    pendingComponent: Pending,
    head: ({ loaderData }) => {
        const photo = loaderData?.photo;
        // The validated loader's key is the canonical identity; the page
        // advertises itself rather than whichever host the request arrived on.
        const pagePath = photo === undefined ? null : photoPagePath(photo.key);
        return {
            meta: [
                { title: "A cat · Jake's Cats" },
                ...(photo === undefined
                    ? []
                    : [
                          { property: "og:image", content: photo.url },
                          { property: "og:image:alt", content: "A cat" },
                          { name: "twitter:image", content: photo.url },
                          { name: "twitter:image:alt", content: "A cat" },
                      ]),
                ...(pagePath === null
                    ? []
                    : [{ property: "og:url", content: `${SITE_URL}${pagePath}` }]),
            ],
        };
    },
});

function PhotoPage() {
    const detail = Route.useLoaderData();
    // Keyed so navigating between two cat pages resets the optimistic state.
    return <PhotoView key={detail.photo.key} detail={detail} />;
}

/**
 * One cat: the photo, its heart count and heart button, and its comments. The
 * heart is optimistic and idempotent — `hearted` comes from the server, so a
 * second heart is impossible from the UI.
 */
function PhotoView({ detail }: { detail: PhotoDetail }) {
    const [photo, setPhoto] = useState(detail.photo);
    const [comments, setComments] = useState<readonly PhotoComment[]>(detail.comments);
    const [body, setBody] = useState("");
    const [sending, setSending] = useState(false);
    const [toast, setToast] = useState<string | null>(null);
    const now = DateTime.toEpochMillis(DateTime.nowUnsafe());

    const heart = () => {
        if (photo.hearted) return;
        const key = photo.key;
        setPhoto((previous) => ({ ...previous, likes: previous.likes + 1, hearted: true }));
        void likePhoto({ data: { key } })
            .then((result) => {
                setPhoto((previous) => ({ ...previous, likes: result.likes, hearted: true }));
            })
            .catch((error: Error) => {
                setPhoto((previous) => ({
                    ...previous,
                    likes: Math.max(0, previous.likes - 1),
                    hearted: false,
                }));
                setToast(failureMessage(error));
            });
    };

    const postComment = () => {
        const trimmed = body.trim();
        if (trimmed.length === 0 || sending) return;
        const submitted = body;
        setSending(true);
        void addComment({ data: { key: photo.key, body: trimmed } })
            .then((result) => {
                setComments((previous) =>
                    [result.comment, ...previous].slice(0, MAX_COMMENTS_PER_PHOTO),
                );
                // Clear only the draft this request submitted; anything typed
                // while it was in flight is newer and stays put.
                setBody((current) => (current === submitted ? "" : current));
            })
            .catch((error: Error) => {
                setToast(failureMessage(error));
            })
            .finally(() => {
                setSending(false);
            });
    };

    return (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-4 py-6">
            <Link
                to="/"
                className="text-pass hover:text-ink focus-visible:ring-ink self-start rounded-sm text-sm font-medium focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden"
            >
                &larr; Back to the deck
            </Link>
            <img
                src={photo.url}
                alt="A cat"
                decoding="async"
                className="bg-card border-line w-full max-w-md self-center rounded-2xl border object-cover"
            />
            <div className="flex items-center justify-between gap-4">
                <HeartCount likes={photo.likes} />
                <HeartButton hearted={photo.hearted} onHeart={heart} />
            </div>
            <section aria-label="Comments" className="flex flex-col gap-4">
                <h2 className="font-display text-ink text-xl font-bold">Comments</h2>
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        postComment();
                    }}
                    className="flex flex-col gap-2"
                >
                    <label htmlFor="comment-body" className="sr-only">
                        Add a comment
                    </label>
                    <textarea
                        id="comment-body"
                        value={body}
                        onChange={(event) => setBody(event.target.value)}
                        maxLength={MAX_COMMENT_LENGTH}
                        rows={3}
                        placeholder="Say something nice about this cat"
                        className="border-line bg-card text-ink placeholder:text-pass focus-visible:ring-ink resize-none rounded-2xl border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-hidden"
                    />
                    <div className="flex items-center justify-between gap-3">
                        <span className="text-pass text-xs tabular-nums">
                            {body.length} / {MAX_COMMENT_LENGTH}
                        </span>
                        <button
                            type="submit"
                            disabled={sending || body.trim().length === 0}
                            className="bg-heart focus-visible:ring-ink focus-visible:ring-offset-cream rounded-full px-4 py-2 text-sm font-semibold text-white focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {sending ? "Posting…" : "Post comment"}
                        </button>
                    </div>
                </form>
                {comments.length === 0 ? (
                    <p className="text-pass text-sm">No comments yet.</p>
                ) : (
                    <ul className="flex flex-col gap-3">
                        {comments.map((comment) => (
                            <li
                                key={comment.id}
                                className="border-line bg-card rounded-2xl border px-3 py-2"
                            >
                                <p className="text-pass flex items-center gap-2 text-xs">
                                    <span className="text-ink font-semibold">
                                        {comment.mine ? "You" : "Anonymous"}
                                    </span>
                                    {/* Relative labels age between SSR and hydration; the
                                        absolute `dateTime` stays authoritative. */}
                                    <time dateTime={comment.createdAt} suppressHydrationWarning>
                                        {relativeTime(comment.createdAt, now)}
                                    </time>
                                </p>
                                <p className="text-ink mt-1 text-sm wrap-break-word whitespace-pre-wrap">
                                    {comment.body}
                                </p>
                            </li>
                        ))}
                    </ul>
                )}
            </section>
            <Toast message={toast} onDismiss={() => setToast(null)} />
        </main>
    );
}

function CatNotFound() {
    return (
        <main className="mx-auto flex w-full max-w-lg flex-1 flex-col items-center gap-3 px-4 py-16 text-center">
            <h1 className="font-display text-ink text-2xl font-bold">That cat wandered off.</h1>
            <Link to="/" className="text-ink text-sm underline underline-offset-4">
                Back to the deck
            </Link>
        </main>
    );
}

function Pending() {
    return (
        <main className="mx-auto w-full max-w-lg flex-1 px-4 py-16 text-center">
            <p className="text-pass text-sm">Fetching a cat…</p>
        </main>
    );
}
