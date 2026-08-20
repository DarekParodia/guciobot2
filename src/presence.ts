import {ActivityType} from 'discord.js';
import type {Client} from 'discord.js';

import {config} from './config';
import {getInsurgencyConfig} from './insurgency/config';
import {queryGameServer} from './insurgency/gameServer';
import * as lxc from './insurgency/lxc';
import {queryRconPlayers} from './insurgency/rcon';
import {createLogger} from './logger';
import {MinecraftServer} from './minecraft';
import {queueManager} from './stream';

const log = createLogger('presence');

const minecraftServer = new MinecraftServer(
    config.minecraft.name, config.minecraft.host, config.minecraft.port);

interface PresenceEntry {
  name: string;
  type: ActivityType.Listening|ActivityType.Watching|ActivityType.Playing;
}

// Everything the bot could plausibly show right now — the currently playing
// song, Minecraft's player count, Insurgency's status/player count if it's
// up. Each source is independent and best-effort: one failing (Minecraft
// unreachable, Insurgency not configured) just drops that entry instead of
// breaking the others.
async function collectPresenceEntries(): Promise<PresenceEntry[]> {
  const entries: PresenceEntry[] = [];

  const currentVideo = queueManager.getCurrentVideo();
  if (currentVideo) {
    entries.push({name: currentVideo.title, type: ActivityType.Listening});
  }

  try {
    const playerCount = await minecraftServer.getPlayerCount();
    entries.push({name: `${playerCount} graczy na guciowni`, type: ActivityType.Watching});
  } catch (err) {
    log.warn('Nie udało się pobrać statusu Minecrafta:', err);
  }

  try {
    const insurgencyConfig = getInsurgencyConfig();
    const status = await lxc.getStatus();
    if (status.status === 'running') {
      let name = 'Insurgency';
      if (insurgencyConfig.gameServerHost && insurgencyConfig.gameServerQueryPort) {
        const gameServerStatus = await queryGameServer(
            insurgencyConfig.gameServerHost, insurgencyConfig.gameServerQueryPort);
        if (gameServerStatus) {
          let numPlayers = gameServerStatus.numPlayers;
          if (insurgencyConfig.rconHost && insurgencyConfig.rconPort && insurgencyConfig.rconPassword) {
            const rconPlayers = await queryRconPlayers(
                insurgencyConfig.rconHost, insurgencyConfig.rconPort, insurgencyConfig.rconPassword);
            if (rconPlayers) numPlayers = rconPlayers.length;
          }
          name = `Insurgency: ${numPlayers}/${gameServerStatus.maxPlayers} graczy`;
        }
      }
      entries.push({name, type: ActivityType.Playing});
    }
  } catch {
    // Insurgency not configured, or the Proxmox call failed — just skip
    // this source, it's not an error worth logging every rotation tick.
  }

  return entries;
}

let rotationIndex = 0;

// Advances the bot's Discord presence by one step through whatever's
// currently available (song playing / Minecraft players / Insurgency
// status), falling back to an idle hint if nothing applies. Call on
// whatever cadence you want the rotation to advance at
// (config.statusUpdateIntervalMs, from bot.ts).
export async function rotatePresence(client: Client): Promise<void> {
  const entries = await collectPresenceEntries();

  if (entries.length === 0) {
    await client.user?.setActivity(
        'Nic się nie dzieje — spróbuj /play', {type: ActivityType.Watching});
    return;
  }

  rotationIndex = (rotationIndex + 1) % entries.length;
  const entry = entries[rotationIndex]!;
  await client.user?.setActivity(entry.name, {type: entry.type});
}
