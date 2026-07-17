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
    let added = 0;
    for (const video of [...songsToAdd].reverse()) {
      if (await queueManager.enqueueNext(video)) added++;
    }
    const skipped = songsToAdd.length - added;

    interaction.editReply(
        skipped > 0 ?
            `**${added}** piosenka(y) została(y) dodana(y) na początek kolejki. Pominięto **${
                skipped}** — kolejka jest pełna.` :
            `**${added}** piosenka(y) została(y) dodana(y) na początek kolejki.`);
  }
};
