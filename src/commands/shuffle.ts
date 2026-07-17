import {SlashCommandBuilder} from 'discord.js';

import {queueManager} from '../stream';

import type {Command} from './types';

export const shuffle: Command = {
  data: new SlashCommandBuilder().setName('shuffle').setDescription(
      'Tasuje kolejkę piosenek.'),
  execute: async (interaction) => {
    queueManager.shuffle();
    interaction.reply('Kolejka została potasowana!');
  }
};
