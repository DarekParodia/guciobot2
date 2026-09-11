// Must be the very first import: everything else may read process.env
// (directly or via ./config) at module-evaluation time, so the .env file
// has to be loaded before any other module is evaluated.
import 'dotenv/config';

import {startApiServer} from './api';
import {DiscordBot} from './bot';
import {config} from './config';
import {createLogger} from './logger';

const log = createLogger('index');

// Handle to the HTTP management API (src/api/) so shutdown can release the
// port. Null when the server failed to start — a port conflict must never
// take the bot itself down.
let apiServer: ReturnType<typeof Bun.serve>|null = null;

async function shutdown(signal: string) {
  log.info(`Received ${signal}, shutting down...`);
  apiServer?.stop(true);
  await DiscordBot.shutdown();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

DiscordBot.login(config.discordToken());

try {
  apiServer = startApiServer();
} catch (error) {
  log.error('Failed to start the API server:', error);
}
