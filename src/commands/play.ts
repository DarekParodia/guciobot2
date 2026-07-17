import {SlashCommandBuilder} from 'discord.js';

import {DiscordBot} from '../bot';
import {queueManager} from '../stream';

import type {Command} from './types';
import {getVoiceChannel, resolveSongsToAdd} from './utils';

export const play: Command = {
  data: new SlashCommandBuilder()
            .setName('play')
            .setDescription('Odtwarza piosenkę z YouTube.')
            .addStringOption(
                option => option.setName('url').setDescription(
                    'URL piosenki do odtworzenia.'))
            .addStringOption(
                option => option.setName('start').setDescription(
                    'Początkowy timestamp (np. 1:23 lub 90 sekund).')),
  execute: async (interaction) => {
    await interaction.deferReply();
    const url = interaction.options.getString('url');
    if (!url) {
      interaction.editReply('Podaj URL piosenki!');
      return;
    }

    const channel = getVoiceChannel(interaction);
    if (!channel) {
      interaction.editReply('Musisz być na kanale głosowym!');
      return;
    }

    if (!queueManager.isPlaying()) await DiscordBot.joinChannel(channel);

    const songsToAdd = await resolveSongsToAdd(interaction, url);
    for (const video of songsToAdd) {
      await queueManager.enqueue(video);
    }

    if (songsToAdd.length === 1) {
      interaction.editReply(`Piosenka **${songsToAdd[0]!.title}** została dodana do kolejki. Piosenki w kolejce: **${
          queueManager.getQueueSize()}**.`);
    } else {
      interaction.editReply(`Piosenki z playlisty zostały dodane do kolejki.`);
    }
  }
};
