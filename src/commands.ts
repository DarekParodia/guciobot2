
import {ChatInputCommandInteraction, SlashCommandBuilder} from 'discord.js';
import type {SlashCommandOptionsOnlyBuilder} from 'discord.js';

import {DiscordBot} from './Discord';
import * as stream from './stream';

export interface Command {
  data: SlashCommandBuilder|SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction) => void;
}

export const commands: Record<string, Command> = {
  ping: {
    data: new SlashCommandBuilder().setName('ping').setDescription(
        'Odpowiada Pong!'),
    execute: (interaction) => {
      interaction.reply('Pong!');
    },
  },
  play: {
    data: new SlashCommandBuilder()
              .setName('play')
              .setDescription('Odtwarza piosenkę z YouTube.')
              .addStringOption(
                  option => option.setName('url').setDescription(
                      'URL piosenki do odtworzenia.')),
    execute: async (interaction) => {
      await interaction.deferReply();
      const url = interaction.options.getString('url');
      if (!url) {
        interaction.editReply('Podaj URL piosenki!');
        return;
      }

      // sprawdz czy typek jest na kanale i jesli tak to go pobierz
      const member = interaction.member;
      // Cast to GuildMember to access .voice
      const channel = (member && 'voice' in member)?,
            (member as import('discord.js').GuildMember).voice.channel: null;
      if (!channel) {
        interaction.editReply('Musisz być na kanale głosowym!');
        return;
      }

      await DiscordBot.joinChannel(channel);

      interaction.editReply(`Dodaję do kolejki url: ${url}`);
      await stream.queueYoutubeStream(url);
    },
    skip: {
      data: new SlashCommandBuilder().setName('skip').setDescription(
          'Pomija aktualnie odtwarzaną piosenkę.'),
      execute: async (interaction) => {
        await interaction.deferReply();
        await stream.skipCurrentYoutubeStream();
        interaction.editReply('Piosenka została pominięta.');
      }
    }
  }
  // Add more commands here
}