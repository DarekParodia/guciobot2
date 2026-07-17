import {AudioPlayer, AudioPlayerStatus, createAudioPlayer, entersState, joinVoiceChannel, VoiceConnectionStatus} from '@discordjs/voice';
import {ActivityType, Client, GatewayIntentBits, MessageFlags, Options, REST, Routes} from 'discord.js';
import type {VoiceBasedChannel} from 'discord.js';

import {commands} from './commands';
import {config} from './config';
import {handleStatusPanelButton, initStatusPanel, refreshStatusPanel} from './insurgency/statusPanel';
import {createLogger} from './logger';
import {MinecraftServer} from './minecraft';
import {queueManager} from './stream';

const log = createLogger('bot');

class DiscordBotClass {
  private client: Client;
  public player: AudioPlayer;
  public voiceChannel: VoiceBasedChannel|null = null;
  private token = '';
  private minecraftServer = new MinecraftServer(
      config.minecraft.name, config.minecraft.host, config.minecraft.port);

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
      // This bot never reads message history, reactions, presences, or any
      // of the other default-cached collections below — caching them just
      // grows memory with server/user activity for no benefit. Guild,
      // channel, and voice-state caches stay at their defaults since
      // joinChannel()/getVoiceChannel() rely on them.
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 0,
        PresenceManager: 0,
        ReactionManager: 0,
        GuildEmojiManager: 0,
        GuildStickerManager: 0,
        GuildInviteManager: 0,
        GuildScheduledEventManager: 0,
        AutoModerationRuleManager: 0,
        ThreadManager: 0,
        ThreadMemberManager: 0,
      }),
    });
    this.player = createAudioPlayer();

    this.client.once('clientReady', async () => {
      log.info(`Bot zalogowany jako ${this.client.user?.tag}`);
      await this.registerCommands();
      await this.updateStatus();
      setInterval(() => this.updateStatus(), config.statusUpdateIntervalMs);

      // No-ops if the (optional) status panel channel isn't configured —
      // see src/insurgency/statusPanel.ts.
      await initStatusPanel(this.client);
      setInterval(() => refreshStatusPanel(), config.statusUpdateIntervalMs);
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.isButton()) {
        try {
          await handleStatusPanelButton(interaction);
        } catch (error) {
          log.error('Błąd podczas obsługi przycisku:', error);
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;

      const command = commands[interaction.commandName];
      if (!command) {
        log.warn(`Nieznana komenda: ${interaction.commandName}`);
        return;
      }

      try {
        await command.execute(interaction);
      } catch (error) {
        log.error(
            `Błąd podczas wykonywania komendy ${interaction.commandName}:`,
            error);

        const errorMessage = 'Wystąpił błąd podczas wykonywania komendy!';
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp(
              {content: errorMessage, flags: MessageFlags.Ephemeral});
        } else {
          await interaction.reply(
              {content: errorMessage, flags: MessageFlags.Ephemeral});
        }
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      log.info('Audio finished playing.');
      queueManager.handleStreamEnd();
    });

    this.player.on('error', error => {
      log.error('Player error:', error.message);
    });
  }

  login(token: string) {
    this.token = token;
    this.client.login(token);
  }

  async joinChannel(channel: VoiceBasedChannel) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    this.voiceChannel = channel;

    try {
      log.info('Waiting for voice connection...');
      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);
      log.info('Voice connection ready!');

      connection.subscribe(this.player);
      return connection;
    } catch (error) {
      log.error('Voice connection error:', error);
      connection.destroy();
      throw error;
    }
  }

  async registerCommands() {
    if (!this.client.application) {
      log.error('Client application nie jest dostępny.');
      return;
    }
    if (!this.token) {
      log.error(
          'Token nie został ustawiony. Nie można zarejestrować komend.');
      return;
    }
    await this.pushCommands(
        Routes.applicationCommands(this.client.application.id));
  }

  // Registers commands for a single guild instead of globally — propagates
  // near-instantly, useful while testing new commands.
  async registerGuildCommands(guildId: string) {
    if (!this.client.application || !this.token) {
      log.error('Client application lub token nie są dostępne.');
      return;
    }
    await this.pushCommands(Routes.applicationGuildCommands(
        this.client.application.id, guildId));
  }

  private async pushCommands(route: `/${string}`) {
    try {
      const commandData = Object.values(commands).map(cmd => cmd.data.toJSON());
      const rest = new REST({version: '10'}).setToken(this.token);

      log.info(`Rozpoczęcie rejestracji ${commandData.length} komend...`);
      await rest.put(route, {body: commandData});
      log.info(`Pomyślnie zarejestrowano ${commandData.length} komend.`);
    } catch (error) {
      log.error('Błąd podczas rejestracji komend:', error);
    }
  }

  async updateStatus() {
    const playerCount = await this.minecraftServer.getPlayerCount();
    await this.client.user?.setActivity(
        `${playerCount} graczy na guciowni`, {type: ActivityType.Playing});
  }

  // Stops any in-flight stream and disconnects — call on process shutdown so
  // spawned yt-dlp/ffmpeg processes and the voice connection don't linger.
  async shutdown() {
    await queueManager.shutdown();
    this.client.destroy();
  }
}

export const DiscordBot = new DiscordBotClass();
