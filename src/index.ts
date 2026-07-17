// Must be the very first import: everything else may read process.env
// (directly or via ./config) at module-evaluation time, so the .env file
// has to be loaded before any other module is evaluated.
import 'dotenv/config';

import {DiscordBot} from './bot';
import {config} from './config';
import {createLogger} from './logger';

const log = createLogger('index');

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down...`);
  await DiscordBot.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

DiscordBot.login(config.discordToken());
