# guciobot

A Discord bot built with Bun and TypeScript.

## Setup

1. Install dependencies:
   ```bash
   bun install
   ```

2. Create a Discord bot and get your token from [Discord Developer Portal](https://discord.com/developers/applications).

3. Add your token to `.env` file:
   ```
   DISCORD_TOKEN=your_actual_discord_bot_token_here
   ```

## Run

```bash
bun start
```

For development with hot reload:

```bash
bun dev
```

This project was created using `bun init` in bun v1.2.21. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Save a video

`/save url:<HTTP(S) video URL>` downloads one video with yt-dlp and posts an
MP4 attachment. Install `yt-dlp`, `ffmpeg` (with libx264/AAC), and `ffprobe`
on the Linux host. Restart the bot to register the slash command.

Media files are kept in a private directory on verified tmpfs, preferring
`/dev/shm`, then the system temporary directory. There is no regular-disk
fallback. tmpfs may use swap according to the host configuration. One save
runs at a time, including upload; concurrent calls receive a busy reply.

The result must be strictly smaller than both **20,000,000 bytes** (decimal
20 MB) and the invoking interaction's Discord attachment limit. Encoding
targets 95% of that limit and checks the finalized file's actual size. A
compatible small MP4 is reused; compatible tracks can be remuxed. Otherwise
two-pass H.264/AAC encoding preserves the full video, with at most one
smaller retry. Live streams, playlist-only links, unknown duration, and
videos that cannot fit at the minimum bitrate are rejected.

The downloader accepts direct HTTP(S) tracks and finite HLS streams that
FFmpeg can read. yt-dlp formats that require native fragment staging, such
as `http_dash_segments`, are skipped when selecting a source.

The optional, lazily loaded `save` section in `config.json` supports:

| Setting | Default | Meaning |
|---|---|---|
| `tmpfsDir` | `/dev/shm`, then system temp | Absolute directory override; must be tmpfs |
| `maxInputBytes` | `268435456` (256 MiB) | Aggregate actual source bytes across video/audio tracks |
| `memoryReserveBytes` | `536870912` (512 MiB) | Memory reserved for child processes and system headroom |

Missing configuration uses these defaults. Invalid save settings only
disable `/save`. Admission also reserves output/upload copies and auxiliary
files, and considers Linux available memory, cgroup v1/v2 ancestor limits,
and free tmpfs space. Source estimates include a 25% margin; unknown sizes
still have a strict actual-byte cap. Resource monitoring is best effort
against other workloads; it does not replace host memory limits.

Progress updates the same Polish reply at most every two seconds, showing
download size/speed when available and each encoding pass/attempt. Estimated
totals are marked; unknown totals do not receive a fabricated percentage.
Processing has a ten-minute overall budget, 45 seconds for metadata and up
to three minutes per downloader/encoder invocation. Upload is bounded and
has no automatic retries. Errors and shutdown terminate child process
groups and remove the workspace after the last reader finishes.

## Checks

```bash
bun x tsc -p tsconfig.json --noEmit
bun test src/save
```

Save tests include local HTTP, real yt-dlp/FFmpeg/ffprobe, tmpfs/cgroup
inspection, byte limits, subprocess cleanup and a local Discord REST
substitute. They require Linux, the external tools, and a writable tmpfs.
Manual end-to-end verification still requires a Discord test guild/token.
