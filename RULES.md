# Rules for coding on guciobot

These are the conventions this codebase follows. Keep new code consistent
with them rather than introducing a parallel style.

## Structure

- One slash command per file in `src/commands/`, exporting a `Command`
  (`{data, execute}`) from `src/commands/types.ts`. Register it in
  `src/commands/index.ts`'s `commands` map — nowhere else.
- Playback state (queue, current stream, playing flag) lives entirely inside
  `queueManager` (`src/stream/queueManager.ts`). Never reintroduce
  module-level `var`/`let` state for the queue — that was the pre-refactor
  design and it made state implicit and hard to reason about. Commands and
  other modules only touch playback through `queueManager`'s public methods.
- `src/stream/youtubeStream.ts` owns the yt-dlp → ffmpeg → Discord audio
  pipeline for a single video. `src/stream/metadata.ts` owns yt-dlp
  *lookups* (single video info, playlist expansion). Don't mix the two
  concerns into one file.
- `src/bot.ts` owns the Discord client, the `AudioPlayer`, voice-channel
  joins, and command registration/dispatch. It should not contain
  music-queue business logic — that belongs in `queueManager`.
- Cross-cutting helpers (timestamp parsing, duration formatting) go in
  `src/utils.ts`, not duplicated per-file. Check there before adding a new
  helper — duration formatting in particular was duplicated three different
  (subtly inconsistent) ways before this was consolidated.
- `src/insurgency/` follows the same split as `src/stream/`: business logic
  (Proxmox API calls, config loading, permission checks) lives there;
  Discord-specific glue (replies, embeds) lives in the `src/commands/*Insurgency.ts`
  files. Don't put `interaction.*` calls inside `src/insurgency/` — **except**
  `statusPanel.ts`, which is the one deliberate exception: it owns both the
  panel message's lifecycle and its button-click handling together, since
  splitting those across two files would mean passing message/interaction
  state back and forth for no real benefit. Any *new* Discord-specific glue
  still belongs in `commands/`.
- `/start_insurgency`, `/stop_insurgency`, and the status panel's buttons all
  end up calling the same `actions.performStart()`/`performStop()` — the
  "already running" and RAM-safeguard checks live there exactly once. Don't
  reimplement them in a new entry point (e.g. a future scheduled auto-start);
  call `actions.ts`.
- `src/insurgency/gameServer.ts` talks to the game server directly (UDP
  query protocol), not through Proxmox at all — keep it that way, don't
  route it through `lxc.ts`. It's inherently best-effort (the query can time
  out even when the container is healthy); callers treat a `null` result as
  "omit this info," never as an error to surface to the user.
- `src/presence.ts`'s `collectPresenceEntries()` gathers presence sources
  (song, Minecraft, Insurgency) independently — each one wrapped in its own
  try/catch. If you add a new source, wrap it the same way: one source
  failing (unreachable server, unconfigured feature) must reduce the
  rotation by one entry, never throw and blank the whole presence.

## Config and secrets

- All environment-driven values go through `src/config.ts`. Don't read
  `process.env` directly elsewhere.
- Host-specific but non-secret settings (e.g. the insurgency LXC container
  ID, the Proxmox node name, RAM thresholds, allowed user IDs) go in
  `config.json` at the repo root — gitignored, with `config.example.json`
  as the committed template. Secrets (API tokens, passwords) always go in
  `.env`, never in `config.json`, even though both are gitignored — `.env`
  is the one place this repo's tooling and conventions assume secrets live.
- Config that's optional (a feature not every deployment uses, like
  Proxmox) must be read *lazily*, on first use of that feature — see
  `config.proxmox.*` in `src/config.ts` and `getInsurgencyConfig()` in
  `src/insurgency/config.ts`. A bot without that config present must still
  boot and serve every other command; the error only surfaces when the
  specific command is actually invoked.
- `import 'dotenv/config'` must stay the first line of `src/index.ts`. ESM
  hoists imports, so anything reading `process.env` at module-evaluation
  time (e.g. a `config.ts` constant, a class field initializer) needs `.env`
  already loaded before its module is evaluated — calling `dotenv.config()`
  from inside a function body runs too late for that.
- Never commit `.env` or print token values in logs.

## Logging

- Use `createLogger('tag')` from `src/logger.ts` (`log.info/warn/error`)
  instead of raw `console.*`. Pick a tag matching the module (`'bot'`,
  `'queue'`, `'ytdlp'`, etc.) so log lines are attributable.
- Every `createLogger()` call is persisted to sqlite (`src/db.ts`, `logs`
  table) as well as printed to the console — this happens automatically,
  don't call `insertLog` directly from feature code. `logs` is pruned to the
  last 30 days at startup (`LOG_RETENTION_DAYS` in `db.ts`); it's a
  debugging tail, not an archive, so don't rely on it for anything that
  needs to survive longer than that.
- Structured, meaningful events that should survive indefinitely (e.g. the
  insurgency start/stop audit trail) get their own table instead of being
  parsed back out of `logs` — see `insurgency_actions` in `src/db.ts` and
  `src/insurgency/audit.ts`. Don't string-match log messages to recover
  structured data; add a proper table.
- User-facing Discord replies are Polish (matches the existing command
  copy); log messages and code/comments are English. Don't mix within a
  single string.

## TypeScript

- `strict` mode is on (see `tsconfig.json`) — keep it that way. Don't add
  `any` to route around a type error; fix the underlying type instead.
- Use `number`/`boolean`, never the boxed `Number`/`Boolean` types.
- `noUncheckedIndexedAccess` is on — array/index access returns
  `T | undefined`. Handle it (narrow, default, or `!` only when a preceding
  bounds check already guarantees it, as in `queueManager.shuffle`'s swap).
- Run `bun x tsc --noEmit` before considering a change done. There is no
  other CI/lint gate in this repo yet — this is the only automated check.

## Async/process hygiene

- Anything that spawns a child process (`yt-dlp`, `ffmpeg`) must be killed
  in the corresponding cleanup path. `YtDlpReadable._destroy` is the model
  to follow — don't let a stopped/skipped stream leave orphan processes.
  `DiscordBot.shutdown()` / `queueManager.shutdown()` must keep working for
  `SIGINT`/`SIGTERM` (see `src/index.ts`) — verify a manual `Ctrl+C` while a
  song is playing doesn't leave `yt-dlp`/`ffmpeg` processes behind
  (`ps aux | grep yt-dlp`) after any change to the stop/shutdown path.

## Talking to self-signed HTTPS services (e.g. Proxmox)

- Never set `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` — it disables
  certificate verification for *every* HTTPS connection in the process,
  including Discord's own REST/gateway traffic, for as long as the flag is
  set. If a client library needs this to talk to a self-signed host (most
  do, via this exact env var — see `proxmox-api`'s README), instead pass a
  custom `fetch` that scopes the bypass to just that client's requests,
  using Bun's `fetch(url, {tls: {rejectUnauthorized: false}})` extension.
  See `src/insurgency/client.ts` for the pattern (including the type-cast
  needed because bundled `undici` types and Bun's global fetch types don't
  match nominally, despite being runtime-compatible).
- The real fix, when available, is trusting the service's CA via
  `NODE_EXTRA_CA_CERTS` so no bypass is needed at all — prefer that if
  you're ever revisiting this.

## Adding a command

1. Create `src/commands/<name>.ts` exporting a `Command`.
2. If it touches the queue, use `queueManager` methods only.
3. If it needs to join voice, reuse `getVoiceChannel()` from
   `src/commands/utils.ts` rather than re-deriving it from
   `interaction.member`.
4. If it shares setup logic with an existing command (e.g. `/play` and
   `/playnext` both resolve a URL to one-or-more `YtVideo`s), extract into
   `src/commands/utils.ts` (see `resolveSongsToAdd`) instead of copy-pasting.
5. Register it in `src/commands/index.ts`.
6. Restart the bot to re-register slash commands globally (takes effect
   near-instantly for guild commands via `registerGuildCommands`, up to ~1h
   globally).

## What not to do

- There's exactly one persistence mechanism: `src/db.ts` (`bun:sqlite`,
  `guciobot.sqlite` at the repo root, gitignored). It exists for logs and
  the insurgency audit trail. Don't add an ORM or a second database/storage
  layer — if a new feature needs to persist something, add a table to
  `db.ts`. Playback state (queue, current stream) still stays in-memory —
  it doesn't need to survive a restart and adding that would be pure
  complexity for no benefit.
- Don't add a generic plugin/event-bus framework for the 11 commands that
  exist. A `Record<string, Command>` lookup is enough at this scale.
- Don't reach for `require()` in new code — this is an ESM project
  (`"type": "module"`), use `import`.
