import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import type {ButtonInteraction, Message, StringSelectMenuInteraction} from 'discord.js';

import {getInsurgencyConfig} from '../insurgency/config';
import {isUserAllowed} from '../insurgency/permissions';
import {execRconCommand} from '../insurgency/rcon';
import {getScenariosByMap, MAP_NAMES} from '../insurgency/scenarios';
import type {MapName, Scenario} from '../insurgency/scenarios';
import {createLogger} from '../logger';

import type {Command} from './types';

const log = createLogger('insurgency');

const SESSION_TIME_MS = 15 * 60 * 1000;
const ANY_MODE = '__ANY__';
type Lighting = 'Day'|'Night';

// Some per-map scenario variants only differ by spawn side/orientation
// (Ambush_East vs Ambush_West), not by anything a player would deliberately
// pick — those get folded into one canonical mode for the select menu.
// Insurgents/Security stay distinct since that's who's attacking.
function canonicalMode(modeLabel: string): string {
  let mode = modeLabel.replace(/ (East|West)$/, '').replace(/ A$/, '');
  if (mode === 'TDM') mode = 'Team Deathmatch';
  return mode;
}

interface DraftState {
  excludedMaps: Set<MapName>;
  mode: string|null;  // null = any mode
  lighting: Lighting;
  mapResult: {map: MapName; scenario: Scenario}|null;
  players: string[];
  team1: string[];
  team2: string[];
  attackTeam: 1|2|null;
  started: boolean;
}

function newState(): DraftState {
  return {
    excludedMaps: new Set(),
    mode: null,
    lighting: 'Day',
    mapResult: null,
    players: [],
    team1: [],
    team2: [],
    attackTeam: null,
    started: false,
  };
}

function shuffled<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function buildEmbed(state: DraftState): EmbedBuilder {
  const embed = new EmbedBuilder()
                    .setTitle('🎖️ Odprawa operacyjna')
                    .setColor(0x8a7752);

  const activeCount = MAP_NAMES.length - state.excludedMaps.size;
  embed.addFields({
    name: '» AO-01/02 — Mapa',
    value: state.mapResult ?
        `**${state.mapResult.map}** — ${state.mapResult.scenario.modeLabel} — ${
            state.lighting === 'Night' ? '🌙 Noc' : '☀️ Dzień'}` :
        `Pula: ${activeCount} / ${MAP_NAMES.length} map · Tryb: ${state.mode ?? 'losowy'} · ${
            state.lighting === 'Night' ? '🌙 Noc' : '☀️ Dzień'}`,
    inline: false,
  });

  if (state.players.length > 0) {
    const label = (name: string, team: 1|2) =>
        state.attackTeam === team ? `🔴 ${name}` : state.attackTeam ? `🫒 ${name}` : name;
    embed.addFields(
        {
          name: `» AO-03 — Team 1${state.attackTeam === 1 ? ' (Atak)' : state.attackTeam === 2 ? ' (Obrona)' : ''}`,
          value: state.team1.length ? state.team1.map(n => label(n, 1)).join('\n') : '—',
          inline: true,
        },
        {
          name: `» AO-03 — Team 2${state.attackTeam === 2 ? ' (Atak)' : state.attackTeam === 1 ? ' (Obrona)' : ''}`,
          value: state.team2.length ? state.team2.map(n => label(n, 2)).join('\n') : '—',
          inline: true,
        },
    );
  }

  if (state.started) {
    embed.addFields({name: '» Status', value: '✅ Mecz wystartowany na serwerze.', inline: false});
    embed.setColor(0x2e7d32);
  }

  return embed;
}

function buildComponents(state: DraftState, modeOptions: string[]) {
  if (state.started) return [];

  const rows = [];

  if (!state.mapResult) {
    const excludeSelect = new StringSelectMenuBuilder()
                               .setCustomId('losowanie_exclude')
                               .setPlaceholder('Wyklucz mapy z puli (opcjonalnie)')
                               .setMinValues(0)
                               .setMaxValues(MAP_NAMES.length)
                               .addOptions(MAP_NAMES.map(name => ({
                                                            label: name,
                                                            value: name,
                                                            default: state.excludedMaps.has(name),
                                                          })));
    const modeSelect = new StringSelectMenuBuilder()
                            .setCustomId('losowanie_mode')
                            .setPlaceholder('Tryb gry (domyślnie: losowy)')
                            .setMinValues(0)
                            .setMaxValues(1)
                            .addOptions(
                                [{label: '🎲 Losowy', value: ANY_MODE, default: state.mode === null}].concat(
                                    modeOptions.map(m => ({label: m, value: m, default: state.mode === m}))));
    const lightingSelect =
        new StringSelectMenuBuilder()
            .setCustomId('losowanie_lighting')
            .setPlaceholder('Pora dnia')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                {label: '☀️ Dzień', value: 'Day', default: state.lighting === 'Day'},
                {label: '🌙 Noc', value: 'Night', default: state.lighting === 'Night'},
            );
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(excludeSelect));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(modeSelect));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(lightingSelect));
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('losowanie_roll_map').setLabel('🎯 Losuj mapę').setStyle(
            ButtonStyle.Primary),
    ));
    return rows;
  }

  if (state.players.length === 0) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('losowanie_add_players').setLabel('👥 Dodaj graczy →').setStyle(
            ButtonStyle.Primary),
    ));
    return rows;
  }

  if (state.attackTeam === null) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('losowanie_roll_attack').setLabel('⚔️ Losuj atak →').setStyle(
            ButtonStyle.Primary),
    ));
    return rows;
  }

  rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('losowanie_start_match').setLabel('✅ Rozpocznij mecz').setStyle(
          ButtonStyle.Success),
  ));
  return rows;
}

async function render(message: Message, state: DraftState, modeOptions: string[]) {
  await message.edit({embeds: [buildEmbed(state)], components: buildComponents(state, modeOptions)});
}

export const losowanie: Command = {
  data: new SlashCommandBuilder().setName('losowanie').setDescription(
      'Odprawa operacyjna: losuje mapę, drużyny i stronę atakującą przed meczem.'),
  execute: async (interaction) => {
    let insurgencyConfig;
    try {
      insurgencyConfig = getInsurgencyConfig();
    } catch (err) {
      await interaction.reply({content: `${err instanceof Error ? err.message : err}`, ephemeral: true});
      return;
    }
    if (!insurgencyConfig.rconHost || !insurgencyConfig.rconPort || !insurgencyConfig.rconPassword) {
      await interaction.reply({
        content: 'Losowanie wymaga skonfigurowanego RCON (rconHost/rconPort/rconPassword w config.json).',
        ephemeral: true,
      });
      return;
    }
    const rconHost = insurgencyConfig.rconHost;
    const rconPort = insurgencyConfig.rconPort;
    const rconPassword = insurgencyConfig.rconPassword;

    await interaction.deferReply();

    const scenariosByMap = await getScenariosByMap(rconHost, rconPort, rconPassword);
    if (!scenariosByMap) {
      await interaction.editReply('Nie udało się połączyć z RCON serwera gry.');
      return;
    }

    const modeOptions = [...new Set(
                             [...scenariosByMap.values()].flat().map(s => canonicalMode(s.modeLabel)))]
                             .sort((a, b) => a.localeCompare(b));

    const state = newState();
    await interaction.editReply({embeds: [buildEmbed(state)], components: buildComponents(state, modeOptions)});
    const message = await interaction.fetchReply();

    const collector = message.createMessageComponentCollector({time: SESSION_TIME_MS});

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        await i.reply({content: 'To nie twoje losowanie — odpal `/losowanie` sam.', ephemeral: true});
        return;
      }

      try {
        if (i.isStringSelectMenu() && i.customId === 'losowanie_exclude') {
          await handleExclude(i, state, modeOptions);
        } else if (i.isStringSelectMenu() && i.customId === 'losowanie_mode') {
          await handleMode(i, state, modeOptions);
        } else if (i.isStringSelectMenu() && i.customId === 'losowanie_lighting') {
          await handleLighting(i, state, modeOptions);
        } else if (i.isButton() && i.customId === 'losowanie_roll_map') {
          await handleRollMap(i, message, state, modeOptions, scenariosByMap);
        } else if (i.isButton() && i.customId === 'losowanie_add_players') {
          await handleAddPlayers(i, message, state, modeOptions);
        } else if (i.isButton() && i.customId === 'losowanie_roll_attack') {
          await handleRollAttack(i, message, state, modeOptions);
        } else if (i.isButton() && i.customId === 'losowanie_start_match') {
          await handleStartMatch(
              i, message, state, insurgencyConfig.allowedUserIds, rconHost, rconPort, rconPassword);
          if (state.started) collector.stop();
        }
      } catch (err) {
        log.error('Błąd w losowaniu:', err);
        if (!i.replied && !i.deferred) {
          await i.reply({content: 'Coś się posypało, sprawdź logi bota.', ephemeral: true});
        }
      }
    });

    collector.on('end', async () => {
      if (state.started) return;
      await message.edit({components: []}).catch(() => {});
    });
  }
};

async function handleExclude(i: StringSelectMenuInteraction, state: DraftState, modeOptions: string[]) {
  state.excludedMaps = new Set(i.values as MapName[]);
  await i.update({embeds: [buildEmbed(state)], components: buildComponents(state, modeOptions)});
}

async function handleMode(i: StringSelectMenuInteraction, state: DraftState, modeOptions: string[]) {
  const value = i.values[0];
  state.mode = !value || value === ANY_MODE ? null : value;
  await i.update({embeds: [buildEmbed(state)], components: buildComponents(state, modeOptions)});
}

async function handleLighting(i: StringSelectMenuInteraction, state: DraftState, modeOptions: string[]) {
  state.lighting = (i.values[0] as Lighting) ?? 'Day';
  await i.update({embeds: [buildEmbed(state)], components: buildComponents(state, modeOptions)});
}

async function handleRollMap(
    i: ButtonInteraction, message: Message, state: DraftState, modeOptions: string[],
    scenariosByMap: Map<MapName, Scenario[]>) {
  await i.deferUpdate();

  const candidates: {map: MapName; scenario: Scenario}[] = [];
  for (const map of MAP_NAMES) {
    if (state.excludedMaps.has(map)) continue;
    for (const scenario of scenariosByMap.get(map) ?? []) {
      if (state.mode !== null && canonicalMode(scenario.modeLabel) !== state.mode) continue;
      candidates.push({map, scenario});
    }
  }

  if (candidates.length === 0) {
    await i.followUp({
      content: 'Brak map z wybranym trybem w aktywnej puli — zmień tryb albo odznacz jakąś mapę.',
      ephemeral: true,
    });
    return;
  }

  state.mapResult = candidates[Math.floor(Math.random() * candidates.length)]!;
  await render(message, state, modeOptions);
}

async function handleAddPlayers(i: ButtonInteraction, message: Message, state: DraftState, modeOptions: string[]) {
  const modal = new ModalBuilder().setCustomId('losowanie_players_modal').setTitle('Gracze na mecz');
  const input = new TextInputBuilder()
                    .setCustomId('players')
                    .setLabel('Gracze, jeden nick na linię')
                    .setStyle(TextInputStyle.Paragraph)
                    .setRequired(true)
                    .setValue(state.players.join('\n'));
  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await i.showModal(modal);

  const submitted = await i.awaitModalSubmit({time: 5 * 60 * 1000, filter: mi => mi.customId === 'losowanie_players_modal'})
                         .catch(() => null);
  if (!submitted) return;

  const players = submitted.fields.getTextInputValue('players')
                      .split('\n')
                      .map(s => s.trim())
                      .filter(Boolean);
  if (players.length < 2) {
    await submitted.reply({content: 'Podaj co najmniej dwóch graczy.', ephemeral: true});
    return;
  }

  state.players = players;
  state.attackTeam = null;
  const shuffledPlayers = shuffled(players);
  state.team1 = shuffledPlayers.filter((_, idx) => idx % 2 === 0);
  state.team2 = shuffledPlayers.filter((_, idx) => idx % 2 === 1);

  await submitted.deferUpdate();
  await render(message, state, modeOptions);
}

async function handleRollAttack(i: ButtonInteraction, message: Message, state: DraftState, modeOptions: string[]) {
  await i.deferUpdate();
  state.attackTeam = Math.random() < 0.5 ? 1 : 2;
  await render(message, state, modeOptions);
}

async function handleStartMatch(
    i: ButtonInteraction, message: Message, state: DraftState, allowedUserIds: string[], rconHost: string,
    rconPort: number, rconPassword: string) {
  if (!isUserAllowed(i.user.id, allowedUserIds)) {
    await i.reply({content: 'Nie masz uprawnień żeby startować meczu na serwerze.', ephemeral: true});
    return;
  }
  await i.deferUpdate();

  if (!state.mapResult) return;

  // `travelscenario` accepts the same URL-option chaining as any other UE
  // level travel — appending "?Lighting=Night" is how community servers
  // pick the night lighting variant added in Operation: Nightfall. Day is
  // the default, so it's simply omitted.
  const target = state.mapResult.scenario.id + (state.lighting === 'Night' ? '?Lighting=Night' : '');
  const travelResult = await execRconCommand(rconHost, rconPort, rconPassword, `travelscenario ${target}`);
  if (travelResult === null) {
    await i.followUp({content: 'Nie udało się połączyć z RCON, żeby zmienić mapę.', ephemeral: true});
    return;
  }

  await message.edit({
    embeds: [buildEmbed(state).setDescription('⏳ Ładowanie mapy na serwerze...')],
    components: [],
  });

  const attackNames = state.attackTeam === 1 ? state.team1 : state.team2;
  const defenseNames = state.attackTeam === 1 ? state.team2 : state.team1;
  const lightingLabel = state.lighting === 'Night' ? 'Noc' : 'Dzien';
  // Short, plain-ASCII-punctuation lines sent as separate `say` calls: one
  // long line of em-dashes/emoji reads as a wall of text in the in-game
  // chat window (narrow, no wrapping control, and the game's font doesn't
  // render most non-Latin symbols), so this mirrors how server admins
  // normally post multi-line announcements.
  const lines = [
    `=== MECZ: ${state.mapResult.map} - ${state.mapResult.scenario.modeLabel} (${lightingLabel}) ===`,
    `ATAK: ${attackNames.join(', ')}`,
    `OBRONA: ${defenseNames.join(', ')}`,
  ];

  // The level reload takes several seconds, during which the game doesn't
  // route console/RCON `say` into chat (and can briefly refuse new RCON
  // connections outright) — sending immediately after `travelscenario`
  // silently drops the message. Wait for the map to come up, then retry the
  // whole announcement a few times in case the server is still loading.
  await Bun.sleep(8000);
  let announced = false;
  for (let attempt = 0; attempt < 4 && !announced; attempt++) {
    announced = true;
    for (const line of lines) {
      const result = await execRconCommand(rconHost, rconPort, rconPassword, `say ${line}`);
      if (result === null) {
        announced = false;
        break;
      }
      await Bun.sleep(300);
    }
    if (!announced) await Bun.sleep(3000);
  }

  state.started = true;
  const finalEmbed = buildEmbed(state);
  if (!announced) {
    finalEmbed.addFields({
      name: '⚠️ Uwaga',
      value: 'Mapa została zmieniona, ale ogłoszenie na czacie serwera nie dotarło (RCON nie odpowiadał).',
      inline: false,
    });
  }
  await message.edit({embeds: [finalEmbed], components: []});
}
