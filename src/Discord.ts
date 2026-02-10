import {AudioPlayer, AudioPlayerStatus, createAudioPlayer, entersState, joinVoiceChannel, VoiceConnectionStatus} from '@discordjs/voice';
import {ActivityType, Client, GatewayIntentBits, REST, Routes} from 'discord.js';
import type {VoiceBasedChannel} from 'discord.js';

import {commands} from './commands';
import {MinecraftServer} from './minecraft';

class DiscordBotClass {
  private client: Client;
  public player: AudioPlayer;
  public voiceChannel: VoiceBasedChannel|null = null;
  private token: string = '';
  private onStreamIdleCallbacks: Array<() => void> = [];
  private minecraftServer: MinecraftServer =
      new MinecraftServer('Guciownia', 'minecraft.darekparodia.com', 25565);

  constructor() {
    this.client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });
    this.player = createAudioPlayer();

    this.client.once('clientReady', async () => {
      console.log(`Bot zalogowany jako ${this.client.user?.tag}`);
      await this.registerCommands();
      await this.updateStatus();
      setInterval(
          () => this.updateStatus(), 60_000);  // Aktualizuj status co minutę
    });

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isCommand()) return;

      const command = commands[interaction.commandName];
      if (!command) {
        console.warn(`Nieznana komenda: ${interaction.commandName}`);
        return;
      }

      try {
        if (interaction.isChatInputCommand()) {
          await command.execute(interaction);
        }
      } catch (error) {
        console.error(
            `Błąd podczas wykonywania komendy ${interaction.commandName}:`,
            error);

        const errorMessage = 'Wystąpił błąd podczas wykonywania komendy!';
        if (interaction.replied || interaction.deferred) {
          await interaction.followUp({content: errorMessage, ephemeral: true});
        } else {
          await interaction.reply({content: errorMessage, ephemeral: true});
        }
      }
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      console.log('Audio finished playing.');

      this.onStreamIdleCallbacks.forEach(callback => callback());
      // connection.destroy(); // Uncomment to leave after playing
    });

    this.player.on('error', error => {
      console.error('Error:', error.message);
    });
  }

  login(token: string) {
    this.token = token;
    this.client.login(token);
  }

  async joinChannel(channel: VoiceBasedChannel) {
    if (!channel) return;


    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
    });
    this.voiceChannel = channel;

    try {
      // Czekaj maksymalnie 30 sekund aż połączenie osiągnie stan 'Ready'
      console.log('Waiting for voice connection...');

      await entersState(connection, VoiceConnectionStatus.Ready, 30_000);

      console.log('Voice connection ready!');

      // Subskrybuj playera dopiero gdy połączenie jest gotowe
      connection.subscribe(this.player);

      return connection;

    } catch (error) {
      console.error('Voice connection error:', error);
      connection.destroy();  // Posprzątaj po nieudanym połączeniu
      throw error;
    }
  }

  async registerCommands() {
    if (!this.client.application) {
      console.error('Client application nie jest dostępny.');
      return;
    }

    if (!this.token) {
      console.error(
          'Token nie został ustawiony. Nie można zarejestrować komend.');
      return;
    }

    try {
      const commandData = Object.values(commands).map(cmd => cmd.data.toJSON());
      const rest = new REST({version: '10'}).setToken(this.token);

      console.log(`Rozpoczęcie rejestracji ${commandData.length} komend...`);

      // Usuń wszystkie poprzednie komendy i zarejestruj nowe
      await rest.put(
          Routes.applicationCommands(this.client.application.id),
          {body: commandData});

      console.log(
          `Pomyślnie zarejestrowano ${commandData.length} komend globalnie.`);
    } catch (error) {
      console.error('Błąd podczas rejestracji komend:', error);
    }
  }

  // Dodatkowa metoda do rejestracji komend dla konkretnego serwera (szybsze
  // testowanie)
  async registerGuildCommands(guildId: string) {
    if (!this.client.application || !this.token) {
      console.error('Client application lub token nie są dostępne.');
      return;
    }

    try {
      const commandData = Object.values(commands).map(cmd => cmd.data.toJSON());
      const rest = new REST({version: '10'}).setToken(this.token);

      console.log(`Rozpoczęcie rejestracji ${
          commandData.length} komend dla serwera ${guildId}...`);

      await rest.put(
          Routes.applicationGuildCommands(this.client.application.id, guildId),
          {body: commandData});

      console.log(
          `Pomyślnie zarejestrowano ${commandData.length} komend dla serwera.`);
    } catch (error) {
      console.error('Błąd podczas rejestracji komend dla serwera:', error);
    }
  }

  async onStreamIdle(callback: () => void) {
    this.onStreamIdleCallbacks.push(callback);
  }

  async updateStatus() {
    const playerCount = await this.minecraftServer.getPlayerCount();
    const statusMessage = `${playerCount} graczy na guciowni`;
    await this.client.user?.setActivity(
        statusMessage, {type: ActivityType.Playing});
  }

  getClient() {
    return this.client;
  }
}

export const DiscordBot = new DiscordBotClass();