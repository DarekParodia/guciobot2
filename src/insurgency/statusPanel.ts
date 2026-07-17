import {ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags} from 'discord.js';
import type {ButtonInteraction, Client, Message} from 'discord.js';

import {getPanelMessage, savePanelMessage} from '../db';
import {createLogger} from '../logger';

import {performStart, performStop} from './actions';
import {getInsurgencyConfig} from './config';
import {buildStatusEmbed} from './embed';
import * as lxc from './lxc';
import {isUserAllowed} from './permissions';

const log = createLogger('insurgency');

const START_BUTTON_ID = 'insurgency:start';
const STOP_BUTTON_ID = 'insurgency:stop';

// The one message this module owns — the channel is meant to hold at most
// this single message, never a log. Re-established from scratch on every
// bot start (see initStatusPanel); if it's later deleted out from under us
// (e.g. by a moderator), refreshStatusPanel() will just log an edit failure
// until the next restart recreates it — not worth self-healing for that.
let panelMessage: Message|null = null;

// Proxmox doesn't flip a container's reported status instantly when you
// call start/stop — pvestatd polls it on its own cadence, so the one
// refresh right after the action often still shows the old state, and
// otherwise nothing corrects it until the next slow
// (config.statusUpdateIntervalMs, normally 60s) tick. So right after an
// action, poll faster for a short burst — stopping as soon as the status
// we were waiting for actually shows up — instead of waiting a whole minute.
const FAST_REFRESH_INTERVAL_MS = 3_000;
const FAST_REFRESH_DURATION_MS = 30_000;

let fastRefreshTimer: ReturnType<typeof setInterval>|null = null;

function stopFastRefresh() {
  if (fastRefreshTimer) {
    clearInterval(fastRefreshTimer);
    fastRefreshTimer = null;
  }
}

function startFastRefreshBurst(expectedStatus: 'running'|'stopped') {
  stopFastRefresh();
  const deadline = Date.now() + FAST_REFRESH_DURATION_MS;
  fastRefreshTimer = setInterval(async () => {
    if (Date.now() >= deadline) {
      stopFastRefresh();
      return;
    }
    const status = await refreshStatusPanel();
    if (status === expectedStatus) stopFastRefresh();
  }, FAST_REFRESH_INTERVAL_MS);
}

function buildComponents(running: boolean) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
          .setCustomId(START_BUTTON_ID)
          .setLabel('Odpal')
          .setStyle(ButtonStyle.Success)
          .setDisabled(running),
      new ButtonBuilder()
          .setCustomId(STOP_BUTTON_ID)
          .setLabel('Zgaś')
          .setStyle(ButtonStyle.Danger)
          .setDisabled(!running),
  )];
}

// Call once at bot startup. No-ops if Insurgency (or just this optional
// panel feature) isn't configured. Tries to reuse the message from a
// previous run first (saved in sqlite — see savePanelMessage/getPanelMessage
// in src/db.ts) so a restart just re-edits it instead of posting a fresh
// one every time, which would ping/notify the channel for no reason. Only
// falls back to wiping stray bot messages and posting a new one if there's
// no saved message or it's gone (e.g. someone deleted it manually).
export async function initStatusPanel(client: Client): Promise<void> {
  let insurgencyConfig;
  try {
    insurgencyConfig = getInsurgencyConfig();
  } catch {
    return;
  }
  if (!insurgencyConfig.statusChannelId) return;

  try {
    const channel = await client.channels.fetch(insurgencyConfig.statusChannelId);
    if (!channel || !channel.isTextBased() || channel.isDMBased()) {
      log.error(`insurgency.statusChannelId (${
          insurgencyConfig.statusChannelId}) nie wskazuje na kanał tekstowy.`);
      return;
    }

    const saved = getPanelMessage();
    if (saved && saved.channelId === insurgencyConfig.statusChannelId) {
      try {
        panelMessage = await channel.messages.fetch(saved.messageId);
        await refreshStatusPanel();
        return;
      } catch {
        log.warn('Zapisana wiadomość panelu już nie istnieje, tworzę nową.');
      }
    }

    const recent = await channel.messages.fetch({limit: 50});
    const ownMessages = recent.filter(m => m.author.id === client.user?.id);
    for (const msg of ownMessages.values()) {
      await msg.delete().catch(
          err => log.warn('Nie udało się usunąć starej wiadomości panelu:', err));
    }

    const status = await lxc.getStatus();
    panelMessage = await channel.send({
      embeds: [await buildStatusEmbed(status, insurgencyConfig)],
      components: buildComponents(status.status === 'running'),
    });
    savePanelMessage(insurgencyConfig.statusChannelId, panelMessage.id);
  } catch (err) {
    log.error('Nie udało się zainicjować panelu statusu Insurgency:', err);
  }
}

// Re-renders the panel message in place, returning the status observed (or
// null on failure/if there's no panel). No-op if the panel was never
// initialized (i.e. the feature isn't configured) — deliberately does not
// hit the Proxmox API at all in that case.
export async function refreshStatusPanel(): Promise<string|null> {
  if (!panelMessage) return null;

  try {
    const insurgencyConfig = getInsurgencyConfig();
    const status = await lxc.getStatus();
    await panelMessage.edit({
      embeds: [await buildStatusEmbed(status, insurgencyConfig)],
      components: buildComponents(status.status === 'running'),
    });
    return status.status;
  } catch (err) {
    log.error('Nie udało się odświeżyć panelu statusu Insurgency:', err);
    return null;
  }
}

// Call after a successful start/stop (slash command or button) instead of
// plain refreshStatusPanel() — does one immediate refresh, then keeps
// polling every few seconds for up to 30s if Proxmox hasn't caught up yet.
export async function refreshStatusPanelAfterAction(expectedStatus: 'running'|'stopped'):
    Promise<void> {
  const status = await refreshStatusPanel();
  if (status !== null && status !== expectedStatus) {
    startFastRefreshBurst(expectedStatus);
  }
}

// Routes a button click from the panel. Returns without doing anything for
// any customId this module doesn't own, so bot.ts can call it unconditionally.
export async function handleStatusPanelButton(interaction: ButtonInteraction): Promise<void> {
  if (interaction.customId !== START_BUTTON_ID && interaction.customId !== STOP_BUTTON_ID) {
    return;
  }

  let insurgencyConfig;
  try {
    insurgencyConfig = getInsurgencyConfig();
  } catch (err) {
    await interaction.reply({
      content: `${err instanceof Error ? err.message : err}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!isUserAllowed(interaction.user.id, insurgencyConfig.allowedUserIds)) {
    await interaction.reply(
        {content: 'Nie masz uprawnień żeby to zmieniać.', flags: MessageFlags.Ephemeral});
    return;
  }

  await interaction.deferUpdate();

  try {
    const isStart = interaction.customId === START_BUTTON_ID;
    const result = isStart ? await performStart(interaction.user, insurgencyConfig) :
                              await performStop(interaction.user, insurgencyConfig);

    if (result.ok) {
      await refreshStatusPanelAfterAction(isStart ? 'running' : 'stopped');
    } else {
      await refreshStatusPanel();
    }
    await interaction.followUp({content: result.message, flags: MessageFlags.Ephemeral});
  } catch (err) {
    log.error('Insurgency button action failed:', err);
    await interaction.followUp(
        {content: 'Coś się posypało, sprawdź logi bota.', flags: MessageFlags.Ephemeral});
  }
}
