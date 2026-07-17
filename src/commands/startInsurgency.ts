import {SlashCommandBuilder} from 'discord.js';

import {performStart} from '../insurgency/actions';
import {getInsurgencyConfig} from '../insurgency/config';
import {isUserAllowed} from '../insurgency/permissions';
import {refreshStatusPanelAfterAction} from '../insurgency/statusPanel';
import {createLogger} from '../logger';

import type {Command} from './types';

const log = createLogger('insurgency');

export const startInsurgency: Command = {
  data: new SlashCommandBuilder().setName('start_insurgency').setDescription(
      'Odpala Insurgency.'),
  execute: async (interaction) => {
    let insurgencyConfig;
    try {
      insurgencyConfig = getInsurgencyConfig();
    } catch (err) {
      log.error('Config error:', err);
      await interaction.reply({
        content: `${err instanceof Error ? err.message : err}`,
        ephemeral: true
      });
      return;
    }

    if (!isUserAllowed(interaction.user.id, insurgencyConfig.allowedUserIds)) {
      await interaction.reply(
          {content: 'Nie masz uprawnień żeby odpalać Insurgency.', ephemeral: true});
      return;
    }

    await interaction.deferReply();

    try {
      const result = await performStart(interaction.user, insurgencyConfig);
      await interaction.editReply(result.message);
      if (result.ok) await refreshStatusPanelAfterAction('running');
    } catch (err) {
      log.error('Failed to start container:', err);
      await interaction.editReply(
          'Coś się posypało przy odpalaniu Insurgency, sprawdź logi bota.');
    }
  }
};
