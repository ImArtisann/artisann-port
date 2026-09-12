-- Visitor-only lookups scan the existing photo-key-first indexes. Put the
-- visitor first for a covering index seek. 0002 is already applied in
-- production, so this index arrives in a new migration.
CREATE INDEX photo_hearts_visitor_idx ON photo_hearts (visitor_id, photo_key);
