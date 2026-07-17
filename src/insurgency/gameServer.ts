import {GameDig} from 'gamedig';

import {createLogger} from '../logger';

const log = createLogger('insurgency');

export interface GameServerStatus {
  numPlayers: number;
  maxPlayers: number;
  mapName: string;
}

// Queries the Insurgency: Sandstorm server itself (Source/Valve query
// protocol over UDP) for live player count — separate from, and
// independent of, the Proxmox API. Returns null if unreachable (container
// just stopped, query port misconfigured, server still booting, etc.) —
// callers just omit this info rather than treating it as a hard error.
export async function queryGameServer(host: string, port: number): Promise<GameServerStatus|null> {
  try {
    const result = await GameDig.query({type: 'insurgencysandstorm', host, port});
    return {
      numPlayers: result.numplayers,
      maxPlayers: result.maxplayers,
      mapName: result.map,
    };
  } catch (err) {
    log.warn(`Nie udało się odpytać serwera gry ${host}:${port}:`, err);
    return null;
  }
}
