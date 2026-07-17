# AGENTS.md

guciobot is a Discord bot (Bun + TypeScript, ESM) that plays YouTube audio
into a voice channel via a queue, and reports a Minecraft server's player
count in its presence status.

Read **[RULES.md](./RULES.md)** before making changes — it has the actual
coding conventions for this repo. This file is the map; RULES.md is the
rulebook.

## Running it

```bash
bun install
bun run src/index.ts   # or: bun start
bun --hot src/index.ts # or: bun dev (hot reload)
```

Requires `yt-dlp` and `ffmpeg` on `PATH` (used as external processes, not
npm dependencies — check with `which yt-dlp ffmpeg` before debugging
playback issues).

Type-check (the only automated check in this repo):

```bash
bun x tsc -p tsconfig.json --noEmit
```

There are no tests and no lint config. Manual verification = run the bot
against a real Discord test guild/token and exercise the slash commands.

## Environment variables

All read through `src/config.ts`:

- `DISCORD_TOKEN` — required, bot token.
- `MINECRAFT_SERVER_NAME` / `MINECRAFT_SERVER_HOST` / `MINECRAFT_SERVER_PORT`
  — optional, default to the Guciownia server.

`.env` is gitignored; copy your token in locally, never commit it.

## Architecture

```
src/index.ts        entry point: loads .env, wires SIGINT/SIGTERM shutdown, logs in
src/bot.ts           Discord client, AudioPlayer, voice-channel joins, command dispatch
src/config.ts        env-var-backed config, single source of truth
src/logger.ts         createLogger(tag) — use instead of console.*
src/utils.ts           shared helpers: parseTimestampToSeconds, formatDuration
src/minecraft.ts        MinecraftServer.getPlayerCount() (used for bot presence)

src/commands/
  index.ts             the `commands` registry — add new commands here
  types.ts             the `Command` interface
  utils.ts              getVoiceChannel(), resolveSongsToAdd() (shared by play/playnext)
  ping.ts play.ts playnext.ts skip.ts queue.ts nowplaying.ts shuffle.ts clearlist.ts
                        one file per slash command

src/stream/
  index.ts             public barrel: YtVideo type, queueManager, yt-dlp lookups
  queueManager.ts       owns queue state + current stream (the only mutable playback state)
  youtubeStream.ts       yt-dlp | ffmpeg -> Discord audio resource, for one video
  metadata.ts             yt-dlp based lookups: queryVideoInfo, isPlaylist, getPlaylistVideos
  types.ts                 YtVideo interface
```

Data flow for `/play`: command resolves the URL to one or more `YtVideo`s
(`resolveSongsToAdd`, expanding playlists via `metadata.ts`) → each is handed
to `queueManager.enqueue()` → if nothing is currently playing, `queueManager`
starts a `YoutubeStream`, which spawns `yt-dlp | ffmpeg` and plays the
resulting Opus stream through `DiscordBot.player`. When the `AudioPlayer`
goes idle, `bot.ts` calls `queueManager.handleStreamEnd()`, which fires the
finished video's `onEnd` callback and advances the queue.

## Slash commands

`ping`, `play`, `playnext`, `skip`, `kolejka` (queue), `coleci` (now
playing), `shuffle`, `clearlist`. User-facing replies are Polish.

## Known constraints / non-goals

- All state (queue, current stream) is in-memory and lost on restart —
  intentional, not a bug to "fix" with persistence.
- Single global queue/player — the bot doesn't support per-guild concurrent
  playback. If that's ever needed, `queueManager` and `DiscordBot.player`
  both need to become per-guild, which is a larger change; don't assume
  it's a small tweak.
