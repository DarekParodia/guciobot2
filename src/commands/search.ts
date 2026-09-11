import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import type {ButtonInteraction, ChatInputCommandInteraction, Message, StringSelectMenuInteraction} from 'discord.js';

import {DiscordBot} from '../bot';
import {createLogger} from '../logger';
import type {SearchSource, YtVideo} from '../stream';
import {queueManager, searchVideos} from '../stream';

import type {Command} from './types';
import {attachNowPlayingNotifications, getVoiceChannel} from './utils';

const log = createLogger('search');

const SESSION_TIME_MS = 2 * 60 * 1000;
const MAX_RESULTS = 10;
const SOURCE_LABEL: Record<SearchSource, string> = {youtube: 'YouTube', soundcloud: 'SoundCloud'};

interface SearchState {
  results: YtVideo[];
  selected: Set<number>;
  finished: boolean;
}

// Discord select-menu option labels are capped at 100 chars.
function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function buildEmbed(query: string, source: SearchSource, state: SearchState, footer?: string): EmbedBuilder {
  const lines = state.results.map((video, i) => {
    const mark = state.selected.has(i) ? '✅' : '▫️';
    return `${mark} **${i + 1}.** ${video.title} (${video.durationString})`;
  });

  return new EmbedBuilder()
      .setTitle(`🔎 Wyniki wyszukiwania: „${query}”`)
      .setColor(0x0099FF)
      .setDescription(lines.join('\n'))
      .setFooter({
        text: footer ??
            `Źródło: ${SOURCE_LABEL[source]} · Zaznacz piosenki w liście poniżej i kliknij „Dodaj do kolejki”.`,
      });
}

function buildComponents(state: SearchState) {
  if (state.finished) return [];

  const select =
      new StringSelectMenuBuilder()
          .setCustomId('search_select')
          .setPlaceholder('Wybierz piosenki do dodania')
          .setMinValues(0)
          .setMaxValues(state.results.length)
          .addOptions(state.results.map((video, i) => ({
                                           label: truncate(video.title, 100),
                                           description: video.durationString,
                                           value: `${i}`,
                                           default: state.selected.has(i),
                                         })));

  const confirmButton = new ButtonBuilder()
                             .setCustomId('search_confirm')
                             .setLabel(`Dodaj do kolejki (${state.selected.size})`)
                             .setStyle(ButtonStyle.Success)
                             .setDisabled(state.selected.size === 0);

  const cancelButton =
      new ButtonBuilder().setCustomId('search_cancel').setLabel('Anuluj').setStyle(ButtonStyle.Secondary);

  return [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
    new ActionRowBuilder<ButtonBuilder>().addComponents(confirmButton, cancelButton),
  ];
}

export const search: Command = {
  data: new SlashCommandBuilder()
            .setName('search')
            .setDescription(
                'Szuka piosenek na YouTube lub SoundCloud i pozwala wybrać, które dodać do kolejki.')
            .addStringOption(
                option => option.setName('query').setDescription('Czego szukać.').setRequired(true))
            .addStringOption(
                option => option.setName('source')
                              .setDescription('Źródło wyszukiwania (domyślnie YouTube).')
                              .addChoices(
                                  {name: 'YouTube', value: 'youtube'},
                                  {name: 'SoundCloud', value: 'soundcloud'},
                                  )),
  execute: async (interaction) => {
    const query = interaction.options.getString('query', true);
    const source = (interaction.options.getString('source') as SearchSource|null) ?? 'youtube';

    await interaction.deferReply();

    let results: YtVideo[];
    try {
      results = await searchVideos(query, source, MAX_RESULTS);
    } catch (err) {
      log.error('Błąd wyszukiwania:', err);
      await interaction.editReply('Nie udało się wyszukać piosenek.');
      return;
    }

    if (results.length === 0) {
      await interaction.editReply(`Brak wyników dla „${query}” (${SOURCE_LABEL[source]}).`);
      return;
    }

    const state: SearchState = {results, selected: new Set(), finished: false};
    await interaction.editReply(
        {embeds: [buildEmbed(query, source, state)], components: buildComponents(state)});
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({time: SESSION_TIME_MS});

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({content: 'To nie twoje wyszukiwanie — odpal `/search` sam.', ephemeral: true});
        return;
      }

      try {
        if (i.isStringSelectMenu() && i.customId === 'search_select') {
          await handleSelect(i, query, source, state);
        } else if (i.isButton() && i.customId === 'search_confirm') {
          await handleConfirm(i, interaction, message, query, source, state);
          if (state.finished) collector.stop();
        } else if (i.isButton() && i.customId === 'search_cancel') {
          await handleCancel(i, query, source, state);
          collector.stop();
        }
      } catch (err) {
        log.error('Błąd w komendzie search:', err);
        if (!i.replied && !i.deferred) {
          await i.reply({content: 'Coś się posypało, sprawdź logi bota.', ephemeral: true});
        }
      }
    });

    collector.on('end', async () => {
      if (state.finished) return;
      await message.edit({components: []}).catch(() => {});
    });
  }
};

async function handleSelect(
    i: StringSelectMenuInteraction, query: string, source: SearchSource, state: SearchState) {
  state.selected = new Set(i.values.map(Number));
  await i.update({embeds: [buildEmbed(query, source, state)], components: buildComponents(state)});
}

async function handleCancel(i: ButtonInteraction, query: string, source: SearchSource, state: SearchState) {
  state.finished = true;
  await i.update({embeds: [buildEmbed(query, source, state, 'Anulowano wyszukiwanie.')], components: []});
}

async function handleConfirm(
    i: ButtonInteraction, interaction: ChatInputCommandInteraction, message: Message, query: string,
    source: SearchSource, state: SearchState) {
  await i.deferUpdate();

  const channel = getVoiceChannel(interaction);
  if (!channel) {
    await i.followUp({content: 'Musisz być na kanale głosowym!', ephemeral: true});
    return;
  }

  if (!queueManager.isPlaying()) await DiscordBot.joinChannel(channel);

  const chosen = [...state.selected].sort((a, b) => a - b).map(idx => state.results[idx]!);
  attachNowPlayingNotifications(interaction, chosen);

  let added = 0;
  for (const video of chosen) {
    if (await queueManager.enqueue(video)) added++;
  }
  const skipped = chosen.length - added;

  state.finished = true;
  const summary = skipped > 0 ?
      `Dodano **${added}** piosenek do kolejki. Pominięto **${skipped}** — kolejka jest pełna.` :
      `Dodano **${added}** piosenek do kolejki.`;
  await message.edit({embeds: [buildEmbed(query, source, state, summary)], components: []});
}
