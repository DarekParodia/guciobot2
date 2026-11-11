import {escapeMarkdown, REST, SlashCommandBuilder} from 'discord.js';

import {createLogger} from '../logger';
import {SaveError} from '../save/errors';
import {getOutputLimit} from '../save/policy';
import {createProgressReporter} from '../save/progress';
import {saveService} from '../save/service';

import type {Command} from './types';
import {editSaveMessage, formatSaveProgress, uploadSavedVideo} from './saveUpload';

const log = createLogger('save');

export const save: Command = {
  data: new SlashCommandBuilder()
            .setName('save')
            .setDescription('Wysyła nagranie z linku w formie filmu do pobrania')
            .addStringOption(
                option => option.setName('url')
                              .setDescription('URL filmu do pobrania.')
                              .setRequired(true)),
  execute: async (interaction) => {
    const startedAt = performance.now();
    await interaction.deferReply();
    const rest = new REST({version: '10', retries: 0, timeout: 30_000, rejectOnRateLimit: () => true});
    let title = '';
    let limit: number|undefined;
    const reporter = createProgressReporter(content =>
      editSaveMessage(rest, interaction.applicationId, interaction.token, content));
    try {
      const url = interaction.options.getString('url');
      if (!url) throw new SaveError('input');
      limit = getOutputLimit(interaction.attachmentSizeLimit);
      reporter.update(`Sprawdzam film i dostępny RAM…\nLimit załącznika: <${limit} bajtów.`);
      await saveService.save(url, interaction.attachmentSizeLimit, progress => {
        if (progress.title) title = escapeMarkdown(progress.title.replace(/[\r\n]/g, ' '));
        reporter.update(`${title ? `**${title}**\n` : ''}${formatSaveProgress(progress)}\nLimit załącznika: <${limit} bajtów.`);
      }, async (video, signal) => {
        await reporter.close();
        await editSaveMessage(rest, interaction.applicationId, interaction.token,
            formatSaveProgress({stage: 'upload', size: video.size, limit: video.limit}),
            AbortSignal.any([signal, AbortSignal.timeout(3000)])).catch(() => {});
        await uploadSavedVideo(rest, interaction.applicationId, interaction.token, video, signal);
        log.info(`Video saved: ${video.size} bytes, ${video.width}x${video.height}, ${video.attempts} encoding attempts`);
      }, startedAt);
    } catch (error) {
      await reporter.close();
      const known = error instanceof SaveError ? error : new SaveError('encode');
      log.warn(`Video save failed (${known.code})`);
      await editSaveMessage(rest, interaction.applicationId, interaction.token,
          `${known.userMessage}${limit ? `\nLimit załącznika: <${limit} bajtów.` : ''}`)
          .catch(() => log.warn('Could not deliver save failure message'));
    } finally {
      await reporter.close();
      rest.clearHashSweeper();
      rest.clearHandlerSweeper();
    }
  }
};
