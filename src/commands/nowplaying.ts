import {SlashCommandBuilder} from 'discord.js';

import {queueManager} from '../stream';

import type {Command} from './types';

export const nowplaying: Command = {
  data: new SlashCommandBuilder().setName('coleci').setDescription(
      'Sprawdza czy aktualnie coś leci.'),
  execute: async (interaction) => {
    const current = queueManager.getCurrentVideo();
    if (current) {
      interaction.reply(
          `Teraz leci: **${current.title}** (${current.durationString}).`);
    } else {
      interaction.reply('Nic nie leci 3:');
    }
  }
};
