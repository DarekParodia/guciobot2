import {createLogger} from '../logger';

const log = createLogger('insurgency');

const SERVERDATA_AUTH = 3;
const SERVERDATA_EXECCOMMAND = 2;
const SERVERDATA_AUTH_RESPONSE = 2;

const AUTH_ID = 1;
const COMMAND_ID = 2;

// How long to wait after the last response fragment before treating a
// command's output as complete. Source RCON responses larger than one
// packet (~4096 bytes) arrive as several packets sharing the same ID with
// no explicit "this is the last one" marker, so we debounce instead.
const RESPONSE_QUIET_MS = 200;
const TIMEOUT_MS = 5000;

export interface RconPlayer {
  name: string;
  steamId: string;
  ip: string;
}

function buildPacket(id: number, type: number, body: string): Buffer {
  const bodyBuf = Buffer.from(body, 'utf-8');
  const size = 4 + 4 + bodyBuf.length + 2;
  const buf = Buffer.alloc(4 + size);
  buf.writeInt32LE(size, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  bodyBuf.copy(buf, 12);
  buf.writeInt16LE(0, 12 + bodyBuf.length);
  return buf;
}

// Opens a Source RCON connection, authenticates, runs a single command, and
// returns its full (possibly multi-packet) output. Returns null on any
// connect/auth/timeout failure — callers treat that as "feature
// unavailable" rather than a hard error, same convention as the A2S query
// in gameServer.ts.
export async function execRconCommand(
    host: string, port: number, password: string, command: string): Promise<string|null> {
  return new Promise((resolve) => {
    let authenticated = false;
    let settled = false;
    let responseBuf = Buffer.alloc(0);
    let commandBody = '';
    let quietTimer: ReturnType<typeof setTimeout>|null = null;
    let socket: Bun.Socket|null = null;

    const finish = (result: string|null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (quietTimer) clearTimeout(quietTimer);
      socket?.end();
      resolve(result);
    };

    const timeout = setTimeout(() => {
      log.warn(`RCON ${host}:${port} timed out`);
      finish(null);
    }, TIMEOUT_MS);

    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(sock) {
          socket = sock;
          sock.write(buildPacket(AUTH_ID, SERVERDATA_AUTH, password));
        },
        data(sock, data) {
          responseBuf = Buffer.concat([responseBuf, Buffer.from(data)]);

          let offset = 0;
          while (offset + 4 <= responseBuf.length) {
            const size = responseBuf.readInt32LE(offset);
            if (offset + 4 + size > responseBuf.length) break;
            const id = responseBuf.readInt32LE(offset + 4);
            const type = responseBuf.readInt32LE(offset + 8);
            const body = responseBuf.toString('utf-8', offset + 12, offset + 4 + size - 2);
            offset += 4 + size;

            if (!authenticated) {
              if (type === SERVERDATA_AUTH_RESPONSE) {
                if (id === -1) {
                  log.warn(`RCON ${host}:${port}: złe hasło`);
                  finish(null);
                  return;
                }
                authenticated = true;
                sock.write(buildPacket(COMMAND_ID, SERVERDATA_EXECCOMMAND, command));
              }
              continue;
            }

            if (id === COMMAND_ID) {
              commandBody += body;
              if (quietTimer) clearTimeout(quietTimer);
              quietTimer = setTimeout(() => finish(commandBody), RESPONSE_QUIET_MS);
            }
          }
          responseBuf = responseBuf.subarray(offset);
        },
        error(_sock, error) {
          log.warn(`RCON ${host}:${port}: błąd połączenia:`, error);
          finish(null);
        },
        close() {
          finish(null);
        },
      },
    }).catch((err) => {
      log.warn(`RCON ${host}:${port}: nie udało się połączyć:`, err);
      finish(null);
    });
  });
}

// Parses "listplayers" RCON output. Insurgency: Sandstorm doesn't put a
// newline between rows — after the header and "===" separator lines, the
// whole player table is one long run of `field | field | ...`, so rows are
// recovered by splitting on "|" and regrouping into fixed-width (ID, Name,
// NetID, IP, Score) chunks. Bots and team/observer labels report an empty
// IP and a "None:INVALID" NetID, so a non-empty IP is what marks a row as
// a real connected player.
function parseListPlayers(output: string): RconPlayer[] {
  const rows = output.split('\n').slice(2).join('\n');
  const fields = rows.split('|').map(f => f.trim());
  if (fields[fields.length - 1] === '') fields.pop();

  const players: RconPlayer[] = [];
  for (let i = 0; i + 5 <= fields.length; i += 5) {
    const [, name, netId, ip] = fields.slice(i, i + 5);
    if (!ip) continue;
    players.push({name: name ?? '', steamId: netId?.replace(/^\w+:/, '') ?? '', ip});
  }
  return players;
}

// Queries the Insurgency: Sandstorm server via Source RCON for the live
// player list. This exists because the game's A2S query (see
// gameServer.ts) reports a stale/zero player count for this game — RCON's
// "listplayers" is the reliable source. Returns null on any
// connect/auth/timeout failure; callers just omit the player list rather
// than treating it as a hard error.
export async function queryRconPlayers(
    host: string, port: number, password: string): Promise<RconPlayer[]|null> {
  const output = await execRconCommand(host, port, password, 'listplayers');
  return output === null ? null : parseListPlayers(output);
}
