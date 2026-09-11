import {createLogger} from '../logger';

import {performStop} from './actions';
import type {InsurgencyConfig} from './config';
import {getInsurgencyConfig} from './config';
import {queryGameServer} from './gameServer';
import * as lxc from './lxc';
import {queryRconPlayers} from './rcon';
import {refreshStatusPanelAfterAction} from './statusPanel';

const log = createLogger('insurgency');

const DEFAULT_IDLE_MINUTES = 60;

// Recorded as the actor in the audit log / status panel when the container
// is stopped by this module rather than a Discord command/button.
const AUTO_SHUTDOWN_ACTOR = {id: 'auto-shutdown', tag: 'Auto (brak graczy)'};

// Timestamp (ms) since the server was first observed running with 0
// players; null while it's not empty (or not running). Module-level state
// is fine — there's only ever one Insurgency instance per bot process.
let emptySince: number|null = null;

// Live player count, or null if it can't be determined (query/RCON
// unreachable, or gameServerHost/gameServerQueryPort isn't configured).
// Callers must treat null as "unknown", not "empty" — a transient query
// failure must never trigger a shutdown.
async function getPlayerCount(insurgencyConfig: InsurgencyConfig): Promise<number|null> {
  if (!insurgencyConfig.gameServerHost || !insurgencyConfig.gameServerQueryPort) return null;

  // RCON's listplayers is the reliable count for this game (see rcon.ts);
  // fall back to the A2S query only if RCON isn't configured/reachable.
  if (insurgencyConfig.rconHost && insurgencyConfig.rconPort && insurgencyConfig.rconPassword) {
    const players = await queryRconPlayers(
        insurgencyConfig.rconHost, insurgencyConfig.rconPort, insurgencyConfig.rconPassword);
    if (players !== null) return players.length;
  }

  const gameServerStatus = await queryGameServer(
      insurgencyConfig.gameServerHost, insurgencyConfig.gameServerQueryPort);
  return gameServerStatus?.numPlayers ?? null;
}

// Call on a periodic tick (see bot.ts). No-ops unless
// gameServerHost/gameServerQueryPort are configured, since there's no
// reliable way to know the player count otherwise. Stops the container
// once nobody has been on it for insurgencyConfig.autoShutdownIdleMinutes
// (default 60) straight.
export async function checkAutoShutdown(): Promise<void> {
  let insurgencyConfig;
  try {
    insurgencyConfig = getInsurgencyConfig();
  } catch {
    return;
  }

  const status = await lxc.getStatus();
  if (status.status !== 'running') {
    emptySince = null;
    return;
  }

  const numPlayers = await getPlayerCount(insurgencyConfig);
  if (numPlayers === null || numPlayers > 0) {
    emptySince = null;
    return;
  }

  if (emptySince === null) {
    emptySince = Date.now();
    log.info('Insurgency: brak graczy, zaczynam odliczanie do auto-wyłączenia.');
    return;
  }

  const idleMinutes = insurgencyConfig.autoShutdownIdleMinutes ?? DEFAULT_IDLE_MINUTES;
  if (Date.now() - emptySince < idleMinutes * 60_000) return;

  log.info(`Insurgency: brak graczy przez ${idleMinutes} min, auto-wyłączanie.`);
  emptySince = null;
  try {
    const result = await performStop(AUTO_SHUTDOWN_ACTOR, insurgencyConfig);
    if (result.ok) await refreshStatusPanelAfterAction('stopped');
  } catch (err) {
    log.error('Insurgency: auto-wyłączanie nie powiodło się:', err);
  }
}
