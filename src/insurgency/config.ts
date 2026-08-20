import {readFileSync} from 'node:fs';
import {join} from 'node:path';

export interface InsurgencyConfig {
  proxmoxNode: string;
  containerId: number;
  minFreeRamMb: number;
  allowedUserIds: string[];
  allowSelfSignedCert: boolean;
  // Optional: a channel that holds a single, continuously-updated status
  // embed (with start/stop buttons) — see src/insurgency/statusPanel.ts.
  // Feature is off if this isn't set.
  statusChannelId?: string;
  // Optional, must be set together: the game server's own address/query
  // port (Source/Valve query protocol, not the Proxmox API) — enables the
  // live map/max-players fields. See src/insurgency/gameServer.ts.
  gameServerHost?: string;
  gameServerQueryPort?: number;
  // Optional, must be set together: Source RCON address/port/password
  // (separate from gameServerQueryPort, configured in the game server's
  // Game.ini). Used instead of the A2S query for the actual player list,
  // since this game's A2S numplayers count is unreliable. See
  // src/insurgency/rcon.ts.
  rconHost?: string;
  rconPort?: number;
  rconPassword?: string;
}

const CONFIG_PATH = join(import.meta.dir, '..', '..', 'config.json');

let cached: InsurgencyConfig|null = null;

// Loads and validates `config.json`'s `insurgency` section on first use,
// then memoizes it. Throws a descriptive error on missing file/fields —
// callers (the insurgency commands) catch this and reply to the user
// instead of letting it crash the bot, since this feature is optional.
export function getInsurgencyConfig(): InsurgencyConfig {
  if (cached) return cached;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    throw new Error(
        `Nie można wczytać config.json (${CONFIG_PATH}). Skopiuj config.example.json i uzupełnij dane. Szczegóły: ${
            err instanceof Error ? err.message : err}`);
  }

  const section = (raw as Record<string, unknown>)?.insurgency;
  if (!section || typeof section !== 'object') {
    throw new Error('config.json nie zawiera sekcji "insurgency".');
  }

  const c = section as Record<string, unknown>;
  const missing = ['proxmoxNode', 'containerId', 'minFreeRamMb', 'allowedUserIds', 'allowSelfSignedCert']
                       .filter(key => c[key] === undefined);
  if (missing.length > 0) {
    throw new Error(
        `config.json: brakuje pól w sekcji "insurgency": ${missing.join(', ')}.`);
  }
  if (typeof c.containerId !== 'number' || typeof c.minFreeRamMb !== 'number') {
    throw new Error(
        'config.json: "containerId" i "minFreeRamMb" muszą być liczbami.');
  }
  if (!Array.isArray(c.allowedUserIds) || c.allowedUserIds.some(id => typeof id !== 'string')) {
    throw new Error('config.json: "allowedUserIds" musi być tablicą stringów (Discord user ID).');
  }
  if (c.statusChannelId !== undefined && typeof c.statusChannelId !== 'string') {
    throw new Error('config.json: "statusChannelId" musi być stringiem (ID kanału).');
  }
  const hasGameServerHost = c.gameServerHost !== undefined;
  const hasGameServerPort = c.gameServerQueryPort !== undefined;
  if (hasGameServerHost !== hasGameServerPort) {
    throw new Error(
        'config.json: "gameServerHost" i "gameServerQueryPort" muszą być ustawione razem.');
  }
  if (hasGameServerHost && typeof c.gameServerHost !== 'string') {
    throw new Error('config.json: "gameServerHost" musi być stringiem.');
  }
  if (hasGameServerPort && typeof c.gameServerQueryPort !== 'number') {
    throw new Error('config.json: "gameServerQueryPort" musi być liczbą.');
  }
  const hasRconHost = c.rconHost !== undefined;
  const hasRconPort = c.rconPort !== undefined;
  const hasRconPassword = c.rconPassword !== undefined;
  if (hasRconHost !== hasRconPort || hasRconHost !== hasRconPassword) {
    throw new Error(
        'config.json: "rconHost", "rconPort" i "rconPassword" muszą być ustawione razem.');
  }
  if (hasRconHost && typeof c.rconHost !== 'string') {
    throw new Error('config.json: "rconHost" musi być stringiem.');
  }
  if (hasRconPort && typeof c.rconPort !== 'number') {
    throw new Error('config.json: "rconPort" musi być liczbą.');
  }
  if (hasRconPassword && typeof c.rconPassword !== 'string') {
    throw new Error('config.json: "rconPassword" musi być stringiem.');
  }

  cached = {
    proxmoxNode: String(c.proxmoxNode),
    containerId: c.containerId,
    minFreeRamMb: c.minFreeRamMb,
    allowedUserIds: c.allowedUserIds as string[],
    allowSelfSignedCert: Boolean(c.allowSelfSignedCert),
    statusChannelId: c.statusChannelId as string | undefined,
    gameServerHost: c.gameServerHost as string | undefined,
    gameServerQueryPort: c.gameServerQueryPort as number | undefined,
    rconHost: c.rconHost as string | undefined,
    rconPort: c.rconPort as number | undefined,
    rconPassword: c.rconPassword as string | undefined,
  };
  return cached;
}
