// Central place for environment-driven configuration. Import this instead of
// reading `process.env` directly elsewhere, and make sure `dotenv/config` has
// already been loaded (index.ts does this as its very first import) before
// any of these values are read.

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  discordToken: () => requireEnv('DISCORD_TOKEN'),

  minecraft: {
    name: process.env.MINECRAFT_SERVER_NAME ?? 'Guciownia',
    host: process.env.MINECRAFT_SERVER_HOST ?? 'minecraft.darekparodia.com',
    port: Number(process.env.MINECRAFT_SERVER_PORT ?? 25565),
  },

  // Only required by the insurgency LXC commands (src/insurgency/) — read
  // lazily so a bot without Proxmox configured still boots fine.
  proxmox: {
    // Bare hostname/IP — the proxmox-api library rejects a full URL here.
    host: () => requireEnv('PROXMOX_HOST'),
    port: Number(process.env.PROXMOX_PORT ?? 8006),
    tokenId: () => requireEnv('PROXMOX_TOKEN_ID'),
    tokenSecret: () => requireEnv('PROXMOX_TOKEN_SECRET'),
  },

  statusUpdateIntervalMs: 60_000,
  // Hard cap on pending (not-yet-playing) queue entries. Bounds memory from
  // someone dropping a massive playlist URL — also used to cap how many
  // entries yt-dlp even fetches for a playlist add, see stream/metadata.ts.
  maxQueueSize: 100,

  ytDlp: {
    // Keep bitrate/rate limits conservative — this runs on modest hardware
    // and the bandwidth cap avoids saturating the host's uplink.
    format: 'bestaudio[abr<=96]/bestaudio/best',
    audioQuality: '96K',
    limitRate: '100K',
  },
};
