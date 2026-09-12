CREATE TABLE photo_likes (
    key TEXT PRIMARY KEY,
    tag TEXT NOT NULL CHECK (tag IN ('life', 'cats')),
    likes INTEGER NOT NULL DEFAULT 0 CHECK (likes >= 0),
    uploaded_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX photo_likes_tag_idx ON photo_likes (tag);
