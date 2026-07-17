import {getLastInsurgencyAction, insertInsurgencyAction} from '../db';
import {createLogger} from '../logger';

const log = createLogger('insurgency');

export interface AuditEntry {
  action: 'start'|'stop';
  userId: string;
  userTag: string;
  at: Date;
}

// Records who started/stopped Insurgency, persisted to sqlite (see
// src/db.ts) — survives a bot restart, unlike the rest of the bot's state.
// Call this right after the Proxmox API call actually succeeds. Takes a
// bare user (id/tag) rather than an interaction so it works the same for
// slash commands and the status panel's buttons.
export function recordAction(
    action: AuditEntry['action'], user: {id: string; tag: string}) {
  insertInsurgencyAction(action, user.id, user.tag);
  log.info(`Insurgency ${action} by ${user.tag} (${user.id})`);
}

export function getLastAction(): AuditEntry|null {
  const row = getLastInsurgencyAction();
  if (!row) return null;
  return {action: row.action, userId: row.user_id, userTag: row.user_tag, at: new Date(row.ts)};
}
