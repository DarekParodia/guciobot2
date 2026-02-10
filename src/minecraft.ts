import {status} from 'minecraft-server-util';

export class MinecraftServer {
  private name: string;
  private ip: string;
  private port: number;

  constructor(name: string, ip: string, port: number) {
    this.name = name;
    this.ip = ip;
    this.port = port;
  }

  async getPlayerCount(): Promise<number> {
    try {
      const result = await status(this.ip, this.port);
      return result.players.online;
    } catch (error) {
      console.error(`Error fetching player count for ${this.name}:`, error);
      return 0;
    }
  }
}