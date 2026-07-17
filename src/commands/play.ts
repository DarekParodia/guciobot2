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
    let added = 0;
    for (const video of songsToAdd) {
      if (await queueManager.enqueue(video)) added++;
    }
    const skipped = songsToAdd.length - added;

    if (songsToAdd.length === 1) {
      interaction.editReply(
          added > 0 ?
              `Piosenka **${songsToAdd[0]!.title}** została dodana do kolejki. Piosenki w kolejce: **${
                  queueManager.getQueueSize()}**.` :
              `Kolejka jest pełna (limit **${queueManager.getQueueSize()}** piosenek).`);
    } else {
      interaction.editReply(
          skipped > 0 ?
              `Dodano **${added}** piosenek z playlisty. Pominięto **${
                  skipped}** — kolejka jest pełna.` :
              `Piosenki z playlisty zostały dodane do kolejki.`);
    }
  }
};
