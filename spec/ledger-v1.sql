CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended','sent','confirmed','failed','reconciled')),
  at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  session_explicit INTEGER NOT NULL,
  intent_key_explicit INTEGER NOT NULL,
  run_instance TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_class TEXT NOT NULL CHECK (tool_class IN ('money','irreversible','standard')),
  policy TEXT NOT NULL CHECK (policy IN ('guard','block-on-doubt')),
  args_json TEXT,
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX events_one_intended ON events(intent_hash, occurrence) WHERE state = 'intended';
CREATE INDEX events_by_intent ON events(intent_hash, occurrence, seq);
CREATE INDEX events_by_action ON events(action_id, seq);
CREATE INDEX events_by_expiry ON events(expires_at_ms);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
