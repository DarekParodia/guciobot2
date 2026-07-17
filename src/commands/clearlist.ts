import {ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, EmbedBuilder, SlashCommandBuilder} from 'discord.js';

import {queueManager} from '../stream';

import type {Command} from './types';

const CONFIRM_ID = 'clearlist-confirm';
const CANCEL_ID = 'clearlist-cancel';

export const clearlist: Command = {
  data: new SlashCommandBuilder().setName('clearlist').setDescription(
      'Wyczyści całą kolejkę.'),
  execute: async (interaction) => {
    const confirmEmbed = new EmbedBuilder()
                              .setTitle('Wyczyścić kolejkę?')
                              .setDescription(
                                  `Kolejka zawiera **${
                                      queueManager.getQueueSize()}** piosenek. Tej akcji nie można cofnąć.`)
                              .setColor(0xFFA500);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(CONFIRM_ID)
            .setLabel('Wyczyść')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(CANCEL_ID)
            .setLabel('Anuluj')
            .setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({embeds: [confirmEmbed], components: [row]});
    const msg = await interaction.fetchReply();

    try {
      const buttonInteraction = await msg.awaitMessageComponent({
        componentType: ComponentType.Button,
        filter: i => i.user.id === interaction.user.id,
        time: 15_000,
      });

      if (buttonInteraction.customId === CONFIRM_ID) {
        queueManager.clear();
        await buttonInteraction.update({
          embeds: [new EmbedBuilder()
                       .setTitle('Kolejka wyczyszczona')
                       .setColor(0x00FF00)],
          components: [],
        });
      } else {
        await buttonInteraction.update({
          embeds: [new EmbedBuilder()
                       .setTitle('Anulowano')
                       .setColor(0x808080)],
          components: [],
        });
      }
    } catch {
      await interaction.editReply({
        embeds: [new EmbedBuilder()
                     .setTitle('Czas minął — anulowano.')
                     .setColor(0x808080)],
        components: [],
      });
    }
  }
};
