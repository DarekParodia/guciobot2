import {EmbedBuilder} from 'discord.js';

import {formatDuration} from '../utils';

import {getLastAction} from './audit';
import type {InsurgencyConfig} from './config';
import {queryGameServer} from './gameServer';
import type {ContainerStatus} from './lxc';

const STATUS_LABELS: Record<string, string> = {
  running: '🟢 Śmiga',
  stopped: '🔴 Stoi',
};

const ACTION_LABELS = {
  start: 'Odpalone przez',
  stop: 'Zgaszone przez',
};

// Shared by the /status_insurgency command and the status panel — keeps
// both representations of "what's Insurgency doing" from drifting apart.
// Async: when the container is running and gameServerHost/gameServerQueryPort
// are configured, it queries the game server itself (Source/Valve query
// protocol) for live player count. A failed/unconfigured query just omits
// the "Gracze" field rather than failing the whole embed.
export async function buildStatusEmbed(
    status: ContainerStatus, insurgencyConfig: InsurgencyConfig): Promise<EmbedBuilder> {
  const memMb = status.memBytes / 1024 / 1024;
  const maxMemMb = status.maxMemBytes / 1024 / 1024;
  const running = status.status === 'running';

  const embed =
      new EmbedBuilder()
          .setTitle('🎮 Insurgency')
          .setDescription(`Kontener: **${status.name}**`)
          .setColor(running ? 0x00FF00 : 0xFF0000)
          .addFields(
              {name: 'Status', value: STATUS_LABELS[status.status] ?? status.status, inline: true},
              {name: 'Uptime', value: running ? formatDuration(status.uptimeSeconds) : '—', inline: true},
              {name: 'CPU', value: running ? `${status.cpuPercent.toFixed(1)}%` : '—', inline: true},
              {name: 'RAM', value: running ? `${memMb.toFixed(0)} / ${maxMemMb.toFixed(0)} MB` : '—', inline: true},
          )
          .setTimestamp();

  if (running && insurgencyConfig.gameServerHost && insurgencyConfig.gameServerQueryPort) {
    const gameServerStatus = await queryGameServer(
        insurgencyConfig.gameServerHost, insurgencyConfig.gameServerQueryPort);
    if (gameServerStatus) {
      embed.addFields({
        name: 'Gracze',
        value: `${gameServerStatus.numPlayers} / ${gameServerStatus.maxPlayers}${
            gameServerStatus.mapName ? ` — ${gameServerStatus.mapName}` : ''}`,
        inline: true,
      });
    }
  }

  const lastAction = getLastAction();
  if (lastAction) {
    const timestamp = Math.floor(lastAction.at.getTime() / 1000);
    embed.addFields({
      name: 'Ostatnia akcja',
      value: `${ACTION_LABELS[lastAction.action]} **${lastAction.userTag}** <t:${timestamp}:R>`,
      inline: false,
    });
  }

  return embed;
}
