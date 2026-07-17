# AGENTS.md

guciobot is a Discord bot (Bun + TypeScript, ESM) that plays YouTube audio
into a voice channel via a queue, reports a Minecraft server's player count
in its presence status, and can start/stop/status-check a Proxmox LXC
container ("insurgency").

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

Logs and the insurgency audit trail live in `guciobot.sqlite` (created
automatically at the repo root, gitignored). Inspect it directly:

```bash
bun -e "
import {Database} from 'bun:sqlite';
const db = new Database('guciobot.sqlite', {readonly: true});
console.log(db.query('SELECT * FROM logs ORDER BY id DESC LIMIT 20').all());
"
```

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
- `PROXMOX_HOST` / `PROXMOX_PORT` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET`
  — optional, only needed for the insurgency commands. `PROXMOX_HOST` is a
  bare hostname/IP (no scheme, no port).

`.env` is gitignored; copy your token in locally, never commit it.

## `config.json`

Host-specific, non-secret settings live in `config.json` at the repo root
(gitignored — copy `config.example.json` and fill it in). Currently just the
`insurgency` section: `proxmoxNode`, `containerId`, `minFreeRamMb`,
`allowedUserIds`, `allowSelfSignedCert`, the optional `statusChannelId`
(enables the status panel — see below), and the optional (must be set
together) `gameServerHost` + `gameServerQueryPort` (enables the live
player-count field — see below). Loaded lazily by `src/insurgency/config.ts`
— missing/invalid config only breaks the insurgency commands, not the rest
of the bot.

## Architecture

```
src/index.ts        entry point: loads .env, wires SIGINT/SIGTERM shutdown, logs in
src/bot.ts           Discord client, AudioPlayer, voice-channel joins, command dispatch
src/config.ts        env-var-backed config, single source of truth
src/logger.ts         createLogger(tag) — use instead of console.*; persists to sqlite
src/db.ts               bun:sqlite (guciobot.sqlite, gitignored): `logs` table (all
                          createLogger output, pruned to 30 days) + `insurgency_actions`
                          table (unpruned audit trail — see insurgency/audit.ts)
src/utils.ts           shared helpers: parseTimestampToSeconds, formatDuration
src/minecraft.ts        MinecraftServer.getPlayerCount() (used for bot presence)

src/commands/
  index.ts             the `commands` registry — add new commands here
  types.ts             the `Command` interface
  utils.ts              getVoiceChannel(), resolveSongsToAdd() (shared by play/playnext)
  ping.ts play.ts playnext.ts skip.ts queue.ts nowplaying.ts shuffle.ts clearlist.ts
  startInsurgency.ts stopInsurgency.ts statusInsurgency.ts
                        one file per slash command

src/stream/
  index.ts             public barrel: YtVideo type, queueManager, resolveVideos
  queueManager.ts       owns queue state + current stream (the only mutable playback state)
                          enforces config.maxQueueSize
  youtubeStream.ts       yt-dlp | ffmpeg -> Discord audio resource, for one video
                          (handles stream backpressure, awaitable stop())
  metadata.ts             resolveVideos(url, limit): one yt-dlp call, handles
                            both single videos and playlists (capped by `limit`)
  types.ts                 YtVideo interface

src/insurgency/
  config.ts             loads/validates config.json's "insurgency" section (lazy)
  client.ts               Proxmox API client (proxmox-api pkg), scoped TLS bypass
                            for self-signed certs — see RULES.md
  lxc.ts                   getStatus(), start(), stop(), getNodeFreeRamMb() (Proxmox API)
  gameServer.ts             queryGameServer(host, port) — live player count via the
                              game server's own Source/Valve query protocol (gamedig
                              pkg), not the Proxmox API; returns null if unreachable
  permissions.ts            isUserAllowed(userId, allowedUserIds)
  audit.ts                  recordAction()/getLastAction() — who started/stopped it
                              last, backed by sqlite's insurgency_actions table
                              (survives restarts)
  actions.ts                performStart()/performStop() — the actual
                              start/stop orchestration (status check, RAM
                              safeguard, audit) shared by the slash commands
                              and the status panel's buttons
  embed.ts                   buildStatusEmbed() — shared by /status_insurgency
                               and the status panel; async, queries the game
                               server for player count when running + configured
  statusPanel.ts               initStatusPanel()/refreshStatusPanel()/
                                 handleStatusPanelButton() — owns the single
                                 self-cleaning status message + buttons
                                 (statusChannelId), see below
```

Data flow for `/play`: command resolves the URL to one or more `YtVideo`s
(`resolveSongsToAdd`, expanding playlists via `stream/metadata.ts`) → each is
handed to `queueManager.enqueue()` (dropped once the queue hits
`config.maxQueueSize`) → if nothing is currently playing, `queueManager`
starts a `YoutubeStream`, which spawns `yt-dlp | ffmpeg` and plays the
resulting Opus stream through `DiscordBot.player`. When the `AudioPlayer`
goes idle, `bot.ts` calls `queueManager.handleStreamEnd()`, which fires the
finished video's `onEnd` callback and advances the queue.

Data flow for `/start_insurgency`: check `isUserAllowed` → load
`insurgency` config → `actions.performStart()` (checks `lxc.getStatus()`,
checks `lxc.getNodeFreeRamMb()` against `minFreeRamMb`, calls `lxc.start()`,
records the action) → `statusPanel.refreshStatusPanelAfterAction('running')`
if a panel is configured. The status panel's Start/Stop buttons go through
the exact same `performStart`/`performStop` functions, so the RAM safeguard
and "already running" checks can't be bypassed by clicking a button instead
of running the slash command.

**Status panel** (optional, `insurgency.statusChannelId`): on bot startup,
`initStatusPanel()` first tries to reuse the message from the previous run
(its channel/message ID is saved in sqlite — `insurgency_panel` table in
`src/db.ts`) by just re-editing it, so a restart doesn't ping the channel
with a brand new message every time. Only if there's no saved message, or
it was deleted out from under the bot, does it fall back to wiping any
stray bot messages in the channel and posting a fresh one (saving its ID
for next time). Either way, from then on the message is edited in place —
never re-sent — on a timer (`config.statusUpdateIntervalMs`, normally 60s)
and after every start/stop, whether triggered by a slash command or a
button click. `refreshStatusPanel()` is a no-op (no Proxmox API call) if
the panel was never initialized, so bots without `statusChannelId` set
don't pay any extra cost.

Proxmox doesn't flip a container's reported status the instant you call
start/stop (pvestatd polls it on its own schedule), so a single refresh
right after the action often still shows the stale state.
`refreshStatusPanelAfterAction(expectedStatus)` — called instead of plain
`refreshStatusPanel()` after a successful start/stop — does one immediate
refresh, and if the status hasn't caught up yet, polls every 3s for up to
30s until it matches (or gives up and lets the normal 60s timer catch it
eventually). This is the *only* place that polls faster than
`config.statusUpdateIntervalMs`, and only for a bounded 30s window.

**Player count** (optional, `gameServerHost` + `gameServerQueryPort`):
`embed.buildStatusEmbed()` calls `gameServer.queryGameServer()` whenever the
container is running and both are set — this hits the game server directly
over UDP (Source/Valve query protocol via the `gamedig` package, type
`insurgencysandstorm`), completely separate from the Proxmox API. It's a
best-effort field: an unreachable/misconfigured query port just means the
"Gracze" field is omitted, not an error shown to the user.

## Slash commands

`ping`, `play`, `playnext`, `skip`, `kolejka` (queue), `coleci` (now
playing), `shuffle`, `clearlist`, `start_insurgency`, `stop_insurgency`,
`status_insurgency`. User-facing replies are Polish.

`start_insurgency`/`stop_insurgency` require the invoking user's Discord ID
to be in `allowedUserIds` in `config.json`; `status_insurgency` is
unrestricted (read-only).

## Known constraints / non-goals

- Playback state (queue, current stream) is in-memory and lost on restart —
  intentional, not a bug to "fix" with persistence. Logs and the insurgency
  audit trail *do* persist, in `guciobot.sqlite` (see `src/db.ts`).
- Single global queue/player — the bot doesn't support per-guild concurrent
  playback. If that's ever needed, `queueManager` and `DiscordBot.player`
  both need to become per-guild, which is a larger change; don't assume
  it's a small tweak.
- The insurgency commands control exactly one hardcoded (via `config.json`)
  LXC container — not a general Proxmox management interface. Extending it
  to multiple containers means `containerId` becomes a per-command option,
  not a bigger config file.
