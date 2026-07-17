import {SlashCommandBuilder} from 'discord.js';

import {getInsurgencyConfig} from '../insurgency/config';
import {buildStatusEmbed} from '../insurgency/embed';
import * as lxc from '../insurgency/lxc';
import {createLogger} from '../logger';

import type {Command} from './types';

const log = createLogger('insurgency');

export const statusInsurgency: Command = {
  data: new SlashCommandBuilder().setName('status_insurgency').setDescription(
      'Pokazuje co się dzieje z Insurgency.'),
  execute: async (interaction) => {
    let insurgencyConfig;
    try {
      insurgencyConfig = getInsurgencyConfig();
    } catch (err) {
      log.error('Config error:', err);
      await interaction.reply(
          {content: `${err instanceof Error ? err.message : err}`, ephemeral: true});
      return;
    }

    await interaction.deferReply();

    try {
      const status = await lxc.getStatus();
      log.info(
          `Status: ${status.status}, uptime=${status.uptimeSeconds}s, cpu=${
              status.cpuPercent.toFixed(1)}%, mem=${status.memBytes}/${
              status.maxMemBytes} bytes`);

      await interaction.editReply({embeds: [await buildStatusEmbed(status, insurgencyConfig)]});
    } catch (err) {
      log.error('Failed to fetch container status:', err);
      await interaction.editReply(
          'Coś się posypało przy sprawdzaniu statusu Insurgency, sprawdź logi bota.');
    }
  }
};
