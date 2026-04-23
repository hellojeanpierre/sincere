import { Database } from "bun:sqlite";

type Statement = ReturnType<Database["prepare"]>;

export interface Event {
  source: string;
  sourceEventId: string;
  type: string;
  subjectId: string | null;
  sourceTime: string | null;
  receivedAt: number;
  payload: unknown;
}

export type InsertResult = "inserted" | "duplicate";

interface DbState {
  db: Database;
  insertStmt: Statement;
  markProcessedStmt: Statement;
  unprocessedStmt: Statement;
}

let state: DbState | null = null;

export function initEvents(dbPath: string): void {
  if (state) return;
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      source           TEXT    NOT NULL,
      source_event_id  TEXT    NOT NULL,
      type             TEXT    NOT NULL,
      subject_id       TEXT,
      source_time      TEXT,
      received_at      INTEGER NOT NULL,
      payload          TEXT    NOT NULL,
      processed_at     INTEGER,
      PRIMARY KEY (source, source_event_id)
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_subject_received
      ON events(subject_id, received_at);
  `);

  state = {
    db,
    insertStmt: db.prepare(`
      INSERT OR IGNORE INTO events
        (source, source_event_id, type, subject_id, source_time, received_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `),
    markProcessedStmt: db.prepare(`
      UPDATE events SET processed_at = ?
      WHERE source = ? AND source_event_id = ?
    `),
    unprocessedStmt: db.prepare(`
      SELECT source, source_event_id, type, subject_id, source_time, received_at, payload
      FROM events
      WHERE processed_at IS NULL
      ORDER BY received_at
    `),
  };
}

function requireState(): DbState {
  if (!state) throw new Error("events module not initialized — call initEvents() first");
  return state;
}

export function insertEvent(event: Event): InsertResult {
  const { insertStmt } = requireState();
  const res = insertStmt.run(
    event.source,
    event.sourceEventId,
    event.type,
    event.subjectId,
    event.sourceTime,
    event.receivedAt,
    JSON.stringify(event.payload),
  );
  return res.changes === 1 ? "inserted" : "duplicate";
}

export function markProcessed(source: string, sourceEventId: string): void {
  const { markProcessedStmt } = requireState();
  markProcessedStmt.run(Date.now(), source, sourceEventId);
}

export function getUnprocessedEvents(): Event[] {
  const { unprocessedStmt } = requireState();
  const rows = unprocessedStmt.all() as Array<{
    source: string;
    source_event_id: string;
    type: string;
    subject_id: string | null;
    source_time: string | null;
    received_at: number;
    payload: string;
  }>;
  return rows.map((r) => ({
    source: r.source,
    sourceEventId: r.source_event_id,
    type: r.type,
    subjectId: r.subject_id,
    sourceTime: r.source_time,
    receivedAt: r.received_at,
    payload: JSON.parse(r.payload),
  }));
}
