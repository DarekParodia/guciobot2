import {Database} from 'bun:sqlite';
import {join} from 'node:path';

// Single sqlite file at the repo root, gitignored (same treatment as .env
// and config.json — it's local, host-specific state).
const DB_PATH = join(import.meta.dir, '..', 'guciobot.sqlite');

const db = new Database(DB_PATH, {create: true});
db.exec('PRAGMA journal_mode = WAL;');

db.run(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    tag TEXT NOT NULL,
    message TEXT NOT NULL
  )
`);
db.run('CREATE INDEX IF NOT EXISTS logs_ts_idx ON logs (ts)');

db.run(`
  CREATE TABLE IF NOT EXISTS insurgency_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    action TEXT NOT NULL,
    user_id TEXT NOT NULL,
    user_tag TEXT NOT NULL
  )
`);

// Single-row table remembering the status panel's message, so a bot restart
// can re-edit the existing message instead of deleting and re-posting one
// (which pings/notifies the channel every time for no reason).
db.run(`
  CREATE TABLE IF NOT EXISTS insurgency_panel (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL
  )
`);

// The `logs` table is a rolling tail for debugging, not an archive — prune
// old rows once at startup so it doesn't grow forever. `insurgency_actions`
// is a low-volume, meaningful audit trail (a handful of rows a day at
// most) and is never pruned.
const LOG_RETENTION_DAYS = 30;
const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
db.run('DELETE FROM logs WHERE ts < ?', [cutoff]);

export type LogLevel = 'info'|'warn'|'error';

const insertLogStmt = db.prepare(
    'INSERT INTO logs (ts, level, tag, message) VALUES (?, ?, ?, ?)');

// Called from every createLogger() call — see src/logger.ts. Never throws:
// a broken log write shouldn't take down whatever was being logged.
export function insertLog(level: LogLevel, tag: string, message: string): void {
  try {
    insertLogStmt.run(new Date().toISOString(), level, tag, message);
  } catch (err) {
    console.error('[db] Failed to write log to sqlite:', err);
  }
}

const insertActionStmt = db.prepare(
    'INSERT INTO insurgency_actions (ts, action, user_id, user_tag) VALUES (?, ?, ?, ?)');

export function insertInsurgencyAction(
    action: 'start'|'stop', userId: string, userTag: string): void {
  insertActionStmt.run(new Date().toISOString(), action, userId, userTag);
}

export interface InsurgencyActionRow {
  ts: string;
  action: 'start'|'stop';
  user_id: string;
  user_tag: string;
}

const lastActionStmt = db.prepare(
    'SELECT ts, action, user_id, user_tag FROM insurgency_actions ORDER BY id DESC LIMIT 1');

export function getLastInsurgencyAction(): InsurgencyActionRow|null {
  return (lastActionStmt.get() as InsurgencyActionRow | undefined) ?? null;
}

const savePanelStmt = db.prepare(`
  INSERT INTO insurgency_panel (id, channel_id, message_id) VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, message_id = excluded.message_id
`);

export function savePanelMessage(channelId: string, messageId: string): void {
  savePanelStmt.run(channelId, messageId);
}

const getPanelStmt =
    db.prepare('SELECT channel_id, message_id FROM insurgency_panel WHERE id = 1');

export function getPanelMessage(): {channelId: string; messageId: string}|null {
  const row = getPanelStmt.get() as {channel_id: string; message_id: string} | undefined;
  return row ? {channelId: row.channel_id, messageId: row.message_id} : null;
}
