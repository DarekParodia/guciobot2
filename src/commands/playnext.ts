import {SlashCommandBuilder} from 'discord.js';

import {DiscordBot} from '../bot';
import {queueManager} from '../stream';

import type {Command} from './types';
import {getVoiceChannel, resolveSongsToAdd} from './utils';

export const playnext: Command = {
  data: new SlashCommandBuilder()
            .setName('playnext')
            .setDescription('Odtwarza piosenkę jako następną.')
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
    // Insert in reverse so the queue keeps the songs' original order at the
    // front (each unshift pushes the previous ones back by one).
    for (const video of [...songsToAdd].reverse()) {
      await queueManager.enqueueNext(video);
    }

    interaction.editReply(`**${songsToAdd.length}** piosenka(y) została(y) dodana(y) na początek kolejki.`);
  }
};
