
import {ChatInputCommandInteraction, EmbedBuilder, SlashCommandBuilder} from 'discord.js';
import type {APIEmbedField, SlashCommandOptionsOnlyBuilder} from 'discord.js';

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
      const channel = (member && 'voice' in member) ?
          (member as import('discord.js').GuildMember).voice.channel :
          null;
      if (!channel) {
        interaction.editReply('Musisz być na kanale głosowym!');
        return;
      }

      if (!(await stream.isSteamPlaying()))
        await DiscordBot.joinChannel(channel);

      let videoInfo = await stream.queryVideoInfo(url);

      videoInfo.onStart = async () => {
        console.log(`Now playing: ${videoInfo.title} aaaaaaaaaaaaaaa`);
        let channelID = interaction.channelId;
        const channel = await interaction.client.channels.fetch(channelID);
        if (!channel || !channel.isTextBased() || channel.isDMBased()) {
          console.warn(
              `Nie można znaleźć kanału tekstowego o ID: ${channelID}`);
          return;
        }

        await channel.send(`Teraz leci: **${videoInfo.title}** (${
            videoInfo.durationString}).`);
        // await interaction.followUp(`Teraz leci: **${videoInfo.title}** (${
        //     videoInfo.durationString}).`);
      };

      videoInfo.onEnd = async () => {
        console.log(`Finished playing: ${videoInfo.title}`);
      };

      stream.queueYoutubeStream(videoInfo);

      interaction.editReply(`Dodaję do kolejki: **${videoInfo.title}** (${
          videoInfo.durationString}). Piosenki w kolejce: **${
          + await stream.getQueueSize() + 1}**.`);
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
      const queue = await stream.getQueue();
      let fields: APIEmbedField[] = [];
      let queueDuration = 0;

      if (queue.length === 0) {
        interaction.reply('Kolejka jest pusta.');
        return;
      }

      const currentStreaminfo = await stream.getCurrentStream().then(
          s => s ? s.getVideoInfo() : null);

      if (currentStreaminfo) {
        fields.push({
          name: `▶️ ${currentStreaminfo.title} (${
              currentStreaminfo.durationString})`,
          inline: false,
          value: ''
        });

        queueDuration += currentStreaminfo.duration;
      }

      for (let i = 0; i < queue.length; i++) {
        if (queue[i]) {
          fields.push({
            name: `${queue[i]!.title} (${queue[i]!.durationString})`,
            inline: false,
            value: ''
          });

          queueDuration += queue[i]!.duration;
        }
      }

      let durationHours = Math.floor(queueDuration / 3600).toFixed(0);
      let durationMinutes = Math.floor((queueDuration % 3600) / 60);
      let durationSeconds = (queueDuration % 60).toFixed(0);

      const queueEmbed =
          new EmbedBuilder()
              .setTitle('Kolejka piosenek')
              .setColor(0x0099FF)
              .addFields(fields)
              .setFooter({
                text: `Łączny czas trwania kolejki: ${durationHours}h ${
                    Math.floor(durationMinutes).toFixed(0)}m ${
                    durationSeconds}s`
              });

      interaction.reply({embeds: [queueEmbed]});
    }
  },
  coleci: {
    data: new SlashCommandBuilder().setName('coleci').setDescription(
        'Sprawdza czy aktualnie coś leci.'),
    execute: async (interaction) => {
      const isPlaying = await stream.isSteamPlaying();
      if (isPlaying) {
        const currentStreamInfo = await stream.getCurrentStream().then(
            s => s ? s.getVideoInfo() : null);
        interaction.reply(`Teraz leci: **${currentStreamInfo?.title}** (${
            currentStreamInfo?.durationString}).`);
      } else {
        interaction.reply('Nic nie leci 3:');
      }
    }
  },
}
// Add more commands here