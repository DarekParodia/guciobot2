
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
      const channel = (member && 'voice' in member)?(member as import('discord.js').GuildMember).voice.channel: null;
      if (!channel) {
        interaction.editReply('Musisz być na kanale głosowym!');
        return;
      }

      if(!(await stream.isSteamPlaying()))
        await DiscordBot.joinChannel(channel);

      let videoInfo = await stream.queryVideoInfo(url);
      await stream.queueYoutubeStream(url);

      interaction.editReply(`Dodaję do kolejki: **${videoInfo.title}** (${videoInfo.duration}). Piosenki w kolejce: **${await stream.getQueueSize() + 1}**.`);
    }
  },
  skip: {
    data: new SlashCommandBuilder().setName('skip').setDescription(
        'Pomija aktualnie odtwarzaną piosenkę.'),
    execute: async (interaction) => {
      await interaction.deferReply();
      await stream.playNextYoutubeStream();
      interaction.editReply('Piosenka została pominięta.');
    }
  },
  kolejka: {
    data: new SlashCommandBuilder().setName('kolejka').setDescription(
        'Wyświetla liczbę piosenek w kolejce.'),
    execute: async (interaction) => {
      const queueSize = await stream.getQueueSize();
      interaction.reply(`Liczba piosenek w kolejce: **${queueSize}**.`);
    }
  }
}
// Add more commands here