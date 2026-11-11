// Must be the very first import: everything else may read process.env
// (directly or via ./config) at module-evaluation time, so the .env file
// has to be loaded before any other module is evaluated.
import 'dotenv/config';

import {once} from 'node:events';

import {startApiServer} from './api';
import {DiscordBot} from './bot';
import {config} from './config';
import {createLogger} from './logger';
import {shutdownSaves} from './save/service';

const log = createLogger('index');

// Handle to the HTTP management API (src/api/) so shutdown can release the
// port. Null when the server failed to start — a port conflict must never
// take the bot itself down.
let apiServer: ReturnType<typeof Bun.serve>|null = null;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down...`);
  apiServer?.stop(true);
  await Promise.allSettled([shutdownSaves(), DiscordBot.shutdown()]);
  process.exit(0);
}

// node:events avoids Bun's Process.on typing shadowing Node's signal overloads.
void once(process, 'SIGINT').then(() => shutdown('SIGINT'));
void once(process, 'SIGTERM').then(() => shutdown('SIGTERM'));

DiscordBot.login(config.discordToken());

try {
  apiServer = startApiServer();
} catch (error) {
  log.error('Failed to start the API server:', error);
}
