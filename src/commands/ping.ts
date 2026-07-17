import {SlashCommandBuilder} from 'discord.js';

import type {Command} from './types';

export const ping: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription(
      'Odpowiada Pong!'),
  execute: (interaction) => {
    interaction.reply('Pong!');
  },
};
