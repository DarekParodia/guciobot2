import {Hono} from 'hono';

import {config} from '../config';
import {createLogger} from '../logger';
import {musicApi} from './music';
import {openApiSpec} from './openapi';

const log = createLogger('api');

// Builds the Hono app for the management API. Kept separate from
// startApiServer so smoke tests can drive it via app.fetch() without
// binding a port.
export function createApiApp(): Hono {
  const app = new Hono();

  app.get('/api/health', (c) =>
      c.json({status: 'ok', uptimeSeconds: Math.floor(process.uptime())}));

  app.route('/api/music', musicApi);

  app.get('/api/openapi.json', (c) => c.json(openApiSpec));

  app.notFound((c) => c.json({error: 'Not found'}, 404));

  app.onError((error, c) => {
    log.error('Unhandled API error:', error);
    return c.json({error: 'Internal server error'}, 500);
  });

  return app;
}

export function startApiServer(): ReturnType<typeof Bun.serve> {
  const app = createApiApp();
  const server = Bun.serve({
    hostname: config.api.host,
    port: config.api.port,
    fetch: app.fetch,
  });
  log.info(`HTTP API listening on http://${server.hostname}:${server.port}`);
  return server;
}
