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

## Config and secrets

- All environment-driven values go through `src/config.ts`. Don't read
  `process.env` directly elsewhere.
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

- Don't add a database, ORM, or persistent storage unless a feature
  actually requires surviving a restart — the bot is intentionally
  stateless today (queue lives in memory).
- Don't add a generic plugin/event-bus framework for the 8 commands that
  exist. A `Record<string, Command>` lookup is enough at this scale.
- Don't reach for `require()` in new code — this is an ESM project
  (`"type": "module"`), use `import`.
