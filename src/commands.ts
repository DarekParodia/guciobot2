
import {ChatInputCommandInteraction, SlashCommandBuilder} from 'discord.js';
import type {SlashCommandOptionsOnlyBuilder} from 'discord.js';

import {DiscordBot} from './Discord';
import {playFromFile, playYoutubeStream} from './stream';

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
      const channel = (member && 'voice' in member) ?
          (member as import('discord.js').GuildMember).voice.channel :
          null;
      if (!channel) {
        interaction.editReply('Musisz być na kanale głosowym!');
        return;
      }

      await DiscordBot.joinChannel(channel);


      interaction.editReply(`Odtwarzanie piosenki! url: ${url}`);
      await playYoutubeStream(url);
      //   await playFromFile('test.mp4');
    },
  },
  playtest: {
    data: new SlashCommandBuilder()
              .setName('playtest')
              .setDescription('Odtwarza piosenkę z pliku.'),
    execute: async (interaction) => {
      await interaction.deferReply();

      // sprawdz czy typek jest na kanale i jesli tak to go pobierz
      const member = interaction.member;
      // Cast to GuildMember to access .voice
      const channel = (member && 'voice' in member) ?
          (member as import('discord.js').GuildMember).voice.channel :
          null;
      if (!channel) {
        interaction.editReply('Musisz być na kanale głosowym!');
        return;
      }

      await DiscordBot.joinChannel(channel);

      await playFromFile('test.mp4');
      interaction.editReply(`Odtwarzanie piosenki z pliku! path: test.mp4`);
    },
  }
  // Add more commands here
}