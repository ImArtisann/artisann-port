CREATE TABLE cats_migration (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('source', 'fenced', 'domain')),
    prepared INTEGER NOT NULL DEFAULT 0,
    hearts_high INTEGER NOT NULL DEFAULT 0,
    comments_high INTEGER NOT NULL DEFAULT 0,
    hearts_cursor INTEGER NOT NULL DEFAULT 0,
    comments_cursor INTEGER NOT NULL DEFAULT 0,
    checkpoint INTEGER NOT NULL DEFAULT 0,
    fence_seq INTEGER,
    handed_off_at TEXT
);
INSERT INTO cats_migration (id, mode) VALUES (1, 'source');
CREATE TABLE cats_source_changes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('heart', 'comment')),
    photo_key TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    comment_id INTEGER,
    body TEXT
);
CREATE TABLE cats_source_heart_ids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_key TEXT NOT NULL,
    visitor_id TEXT NOT NULL,
    UNIQUE (photo_key, visitor_id)
);
CREATE TRIGGER cats_hearts_fence BEFORE INSERT ON photo_hearts
BEGIN
    SELECT RAISE(ABORT, 'cats_source_fenced')
    WHERE COALESCE((SELECT mode FROM cats_migration WHERE id = 1), 'fenced') != 'source';
END;
CREATE TRIGGER cats_comments_fence BEFORE INSERT ON photo_comments
BEGIN
    SELECT RAISE(ABORT, 'cats_source_fenced')
    WHERE COALESCE((SELECT mode FROM cats_migration WHERE id = 1), 'fenced') != 'source';
END;
CREATE TRIGGER cats_capture_heart AFTER INSERT ON photo_hearts
BEGIN
    INSERT INTO cats_source_heart_ids (photo_key, visitor_id)
    VALUES (NEW.photo_key, NEW.visitor_id) ON CONFLICT DO NOTHING;
    INSERT INTO cats_source_changes (kind, photo_key, visitor_id, created_at)
    VALUES ('heart', NEW.photo_key, NEW.visitor_id, NEW.created_at);
END;
CREATE TRIGGER cats_capture_comment AFTER INSERT ON photo_comments
BEGIN
    INSERT INTO cats_source_changes (kind, photo_key, visitor_id, created_at, comment_id, body)
    VALUES ('comment', NEW.photo_key, NEW.visitor_id, NEW.created_at, NEW.id, NEW.body);
END;
-- The source API is append-only. Reject unsupported edits instead of letting
-- a repair or an older writer invalidate an in-flight baseline silently.
CREATE TRIGGER cats_hearts_no_update BEFORE UPDATE ON photo_hearts
BEGIN SELECT RAISE(ABORT, 'cats_source_append_only'); END;
CREATE TRIGGER cats_hearts_no_delete BEFORE DELETE ON photo_hearts
BEGIN SELECT RAISE(ABORT, 'cats_source_append_only'); END;
CREATE TRIGGER cats_comments_no_update BEFORE UPDATE ON photo_comments
BEGIN SELECT RAISE(ABORT, 'cats_source_append_only'); END;
CREATE TRIGGER cats_comments_no_delete BEFORE DELETE ON photo_comments
BEGIN SELECT RAISE(ABORT, 'cats_source_append_only'); END;
INSERT INTO cats_source_heart_ids (photo_key, visitor_id)
SELECT photo_key, visitor_id FROM photo_hearts WHERE true
ORDER BY photo_key, visitor_id ON CONFLICT DO NOTHING;
CREATE TABLE cats_domain_hearts (
    photo_key TEXT NOT NULL, visitor_id TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (photo_key, visitor_id)
);
CREATE INDEX cats_domain_hearts_visitor ON cats_domain_hearts(visitor_id);
CREATE TABLE cats_domain_comments (
    photo_key TEXT NOT NULL, id INTEGER NOT NULL, visitor_id TEXT NOT NULL,
    body TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (photo_key, id)
);
