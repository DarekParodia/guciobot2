import {SlashCommandBuilder} from 'discord.js';

import {performStop} from '../insurgency/actions';
import {getInsurgencyConfig} from '../insurgency/config';
import {isUserAllowed} from '../insurgency/permissions';
import {refreshStatusPanelAfterAction} from '../insurgency/statusPanel';
import {createLogger} from '../logger';

import type {Command} from './types';

const log = createLogger('insurgency');

export const stopInsurgency: Command = {
  data: new SlashCommandBuilder().setName('stop_insurgency').setDescription(
      'Gasi Insurgency.'),
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

    if (!isUserAllowed(interaction.user.id, insurgencyConfig.allowedUserIds)) {
      await interaction.reply(
          {content: 'Nie masz uprawnień żeby gasić Insurgency.', ephemeral: true});
      return;
    }

    await interaction.deferReply();

    try {
      const result = await performStop(interaction.user, insurgencyConfig);
      await interaction.editReply(result.message);
      if (result.ok) await refreshStatusPanelAfterAction('stopped');
    } catch (err) {
      log.error('Failed to stop container:', err);
      await interaction.editReply(
          'Coś się posypało przy gaszeniu Insurgency, sprawdź logi bota.');
    }
  }
};
