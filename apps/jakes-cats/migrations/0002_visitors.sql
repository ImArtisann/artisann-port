DROP INDEX photo_likes_tag_idx;
DROP TABLE photo_likes;
CREATE TABLE photos (
    key TEXT PRIMARY KEY,
    tag TEXT NOT NULL CHECK (tag IN ('life', 'cats')),
    uploaded_at TEXT,
    created_at TEXT NOT NULL
);
CREATE INDEX photos_tag_idx ON photos (tag);
CREATE TABLE photo_hearts (
    photo_key TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (photo_key, visitor_id)
);
CREATE INDEX photo_hearts_photo_idx ON photo_hearts (photo_key);
CREATE TABLE photo_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_key TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 280),
    created_at TEXT NOT NULL
);
CREATE INDEX photo_comments_photo_idx ON photo_comments (photo_key, id);
