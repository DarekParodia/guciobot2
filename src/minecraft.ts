import {status} from 'minecraft-server-util';

import {createLogger} from './logger';

const log = createLogger('minecraft');

export class MinecraftServer {
  constructor(
      private readonly name: string, private readonly ip: string,
      private readonly port: number) {}

  async getPlayerCount(): Promise<number> {
    try {
      const result = await status(this.ip, this.port);
      return result.players.online;
    } catch (error) {
      log.error(`Error fetching player count for ${this.name}:`, error);
      return 0;
    }
  }
}
