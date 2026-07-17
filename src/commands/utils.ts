import type {ChatInputCommandInteraction, GuildMember} from 'discord.js';

import {createLogger} from '../logger';
import type {YtVideo} from '../stream';
import {getPlaylistVideos, isPlaylist, queryVideoInfo} from '../stream';
import {parseTimestampToSeconds} from '../utils';

const log = createLogger('commands');

// Resolves the voice channel the invoking member is currently in, or null
// if they aren't in one (e.g. DM interactions, or not connected to voice).
export function getVoiceChannel(interaction: ChatInputCommandInteraction) {
  const member = interaction.member;
  return (member && 'voice' in member) ?
      (member as GuildMember).voice.channel :
      null;
}

// Shared by /play and /playnext: resolves the `url` option to one or more
// YtVideo entries (expanding playlists), applies the `start` timestamp
// option when given, and wires up the "now playing" notification.
export async function resolveSongsToAdd(
    interaction: ChatInputCommandInteraction, url: string): Promise<YtVideo[]> {
  const songs = await isPlaylist(url) ? await getPlaylistVideos(url) :
                                         [await queryVideoInfo(url)];

  if (songs.length === 1) {
    const startOption = interaction.options.getString('start');
    if (startOption) {
      const parsed = parseTimestampToSeconds(startOption);
      if (!isNaN(parsed) && parsed > 0) songs[0]!.startSeconds = parsed;
    }
  }

  for (const video of songs) {
    video.onStart = async () => {
      const channel = await interaction.client.channels.fetch(interaction.channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        log.warn(`Nie można znaleźć kanału tekstowego o ID: ${interaction.channelId}`);
        return;
      }
      await channel.send(
          `Teraz leci: **${video.title}** (${video.durationString}).`);
    };
    video.onEnd = async () => {
      log.info(`Finished playing: ${video.title}`);
    };
  }

  return songs;
}

export {formatDuration} from '../utils';
