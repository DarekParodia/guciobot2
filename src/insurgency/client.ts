import proxmoxApi from 'proxmox-api';
import type {Proxmox} from 'proxmox-api';

import {config} from '../config';
import type {InsurgencyConfig} from './config';

let client: Proxmox.Api|null = null;

// Creates (and memoizes) the Proxmox API client.
//
// When `insurgencyConfig.allowSelfSignedCert` is set, TLS verification is
// bypassed only for requests made through this client — via Bun's
// `fetch(url, {tls: {rejectUnauthorized: false}})` extension — instead of
// the commonly-suggested `NODE_TLS_REJECT_UNAUTHORIZED=0` env var, which
// would disable certificate checking for every HTTPS connection in the
// process (including Discord's own REST/gateway traffic). If Proxmox's CA
// is ever added to the trust store (e.g. via NODE_EXTRA_CA_CERTS),
// `allowSelfSignedCert` can be set back to false.
export function getProxmoxClient(insurgencyConfig: InsurgencyConfig): Proxmox.Api {
  if (client) return client;

  client = proxmoxApi({
    host: config.proxmox.host(),
    port: config.proxmox.port,
    tokenID: config.proxmox.tokenId(),
    tokenSecret: config.proxmox.tokenSecret(),
    // Cast: proxmox-api types its `fetch` option against undici's
    // Request/Response, which are structurally — but not nominally —
    // identical to Bun's global fetch types. Both implement the standard
    // Fetch API at runtime, so this is safe despite TS disagreeing.
    fetch: insurgencyConfig.allowSelfSignedCert ?
        (((url: string|URL, init?: RequestInit) =>
              fetch(url, {...init, tls: {rejectUnauthorized: false}})) as any) :
        undefined,
  });
  return client;
}
