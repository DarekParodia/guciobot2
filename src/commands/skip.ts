import {SlashCommandBuilder} from 'discord.js';

import {queueManager} from '../stream';

import type {Command} from './types';

export const skip: Command = {
  data: new SlashCommandBuilder().setName('skip').setDescription(
      'Pomija aktualnie odtwarzaną piosenkę.'),
  execute: async (interaction) => {
    await interaction.deferReply();
    await queueManager.skip();
    interaction.editReply('Piosenka została pominięta.');
  }
};
