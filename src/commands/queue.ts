import {EmbedBuilder, SlashCommandBuilder} from 'discord.js';
import type {APIEmbedField} from 'discord.js';

import {queueManager} from '../stream';

import type {Command} from './types';
import {formatDuration} from './utils';

export const queue: Command = {
  data: new SlashCommandBuilder().setName('kolejka').setDescription(
      'Wyświetla liczbę piosenek w kolejce.'),
  execute: async (interaction) => {
    const items = queueManager.getQueue();
    const current = queueManager.getCurrentVideo();

    if (items.length === 0 && !current) {
      interaction.reply('Kolejka jest pusta.');
      return;
    }

    const fields: APIEmbedField[] = [];
    let totalDuration = 0;

    if (current) {
      fields.push({
        name: `▶️ ${current.title} (${current.durationString})`,
        inline: false,
        value: '',
      });
      totalDuration += current.duration;
    }

    for (const video of items) {
      fields.push({
        name: `${video.title} (${video.durationString})`,
        inline: false,
        value: '',
      });
      totalDuration += video.duration;
    }

    const queueEmbed =
        new EmbedBuilder()
            .setTitle('Kolejka piosenek')
            .setColor(0x0099FF)
            .addFields(fields)
            .setFooter(
                {text: `Łączny czas trwania kolejki: ${formatDuration(totalDuration)}`});

    interaction.reply({embeds: [queueEmbed]});
  }
};
