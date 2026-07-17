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

  statusUpdateIntervalMs: 60_000,
  maxQueueSize: 15,

  ytDlp: {
    // Keep bitrate/rate limits conservative — this runs on modest hardware
    // and the bandwidth cap avoids saturating the host's uplink.
    format: 'bestaudio[abr<=96]/bestaudio/best',
    audioQuality: '96K',
    limitRate: '100K',
  },
};
