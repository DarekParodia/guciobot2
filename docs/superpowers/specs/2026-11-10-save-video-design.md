# /save video download and compression

Status: approved by the user; implementation tracked in the matching plan.

## Intent and agreed constraints

`/save url:<video URL>` downloads one complete video with yt-dlp, compresses
it when necessary, and posts a downloadable MP4 to Discord. Media is stored
in memory-backed files on Linux. Replies and progress are Polish; code,
comments, logs, and project documentation are English.

The user selected tmpfs storage. The user requested a result strictly below
20 MB, checking source size before download when possible, RAM admission
checks, and useful progress. The defaults below are implementation proposals,
not additional preferences already confirmed by the user.

No disk fallback, trimming, playlist expansion, live capture, HTTP API,
playback-queue integration, or new dependencies are included. Existing local
changes to `togif.ts` must be preserved.

## Approaches considered

- Bun buffers: keep the source in application memory, but piping a buffer
  into FFmpeg does not provide seeking for arbitrary MP4/MOV inputs. A
  separate seekable adapter would add unnecessary complexity.
- Verified tmpfs files (selected): seekable input/output, straightforward
  ffprobe inspection, two-pass encoding, and retry without downloading again.
- Direct yt-dlp-to-FFmpeg streaming: smaller source footprint, but does not
  retain the source and complicates format compatibility and retries.

tmpfs can use swap. This design promises verified tmpfs storage and no
fallback to a regular filesystem, not locked physical RAM or disabled swap.

## Exact output rules

Use decimal MB for the product limit and displays:

```
productLimit = 20_000_000
discordLimit = interaction.attachmentSizeLimit
limit = min(productLimit, discordLimit)
targetBytes = floor(limit * 0.95)
eligible = size > 0 && size < limit
```

Reject an invalid/missing Discord limit with a clear error instead of
guessing a larger allowance. Compare integer bytes, never rounded labels.
Show the applicable limit and exact bytes when explaining an oversize error.

A successful output also requires a zero process exit code, a readable video
stream, a finite positive duration, and preservation of the complete source
timeline (within `max(1 second, 1% of source duration)`). Use downloaded-media
ffprobe information for this check, not just website metadata. Preserve the
selected audio stream when one exists; silent video is supported. Do not
use `-shortest` or `-fs` to make a result fit by truncating it.

## Storage and admission

- Prefer `/dev/shm`, then `os.tmpdir()`, accepting only a verified tmpfs
  filesystem. Create a private per-job directory with restrictive permissions.
  Check the directory actually selected, including symlink resolution.
- Keep source tracks, metadata, pass logs, and output in that directory.
  Disable yt-dlp user configuration and persistent cache so command behavior
  and temporary-file destinations are controlled by the feature.
- Allow one active `/save` globally, including metadata and upload. Reject a
  concurrent call promptly in Polish; do not create a waiting queue whose
  interaction token could expire. This is separate from music queue state.
- Compute available memory `H` from Linux `MemAvailable`, constrained by
  finite cgroup limits and current usage, including applicable ancestors.
  Support cgroup v2 and v1; a detected but unreadable limit must not silently
  become unlimited. An unavailable required measurement produces a useful
  feature error, without preventing bot startup.
- Let `F` be free bytes on the chosen tmpfs. Proposed source admission cap:

```
MiB = 1_048_576
I = floor(min(256 * MiB,
              H - 512 * MiB - 2 * limit - 32 * MiB,
              F - 2 * limit - 32 * MiB))
```

  Here 512 MiB covers child-process work and system headroom; `2 * limit`
  allows output plus upload buffering, and 32 MiB allows metadata/pass logs.
  If `I <= 0`, fail before downloading. These are conservative admission
  estimates, not a guarantee against OOM caused by unrelated workloads.
- Recheck headroom before encoding and monitor memory/tmpfs during active
  processing, approximately every 500 ms. Stop if available memory falls
  below 128 MiB or workspace usage exceeds its reserved budget. The source
  byte counter below is the strict input cap; periodic resource monitoring
  is an additional best-effort guard. Existing `/togif` usage is reflected
  in current available memory; this change does not rewrite that command.

## Metadata, format choice, and bounded download

Validate an HTTP(S) URL and invoke processes with argument arrays, never
shell interpolation. Defer the interaction immediately. Metadata extraction
uses yt-dlp JSON, no download, no playlist expansion, and a timeout. Reject
playlist-only results, live/upcoming streams, missing video, and unknown or
invalid duration. A video URL carrying a playlist parameter saves only that
video. Reject sources requiring unsupported authentication/DRM with an
appropriate Polish error.

Select video at no more than 720 pixels on its shorter dimension, considering
orientation. Prefer the highest resolution fitting admission, then useful
frame rate and codec quality. Prefer a combined audio/video representation
at comparable quality; support separate tracks when no suitable combined
format exists. Do not merge source tracks into an additional full-size file.
ffprobe/FFmpeg can receive the downloaded video and audio paths separately.

Use selected-format `filesize`, otherwise `filesize_approx`; if absent,
duration times bitrate may provide an explicitly approximate estimate. Sum
selected track estimates. Admit a known/estimated source when `1.25 * S <= I`;
otherwise try smaller representations before rejecting it. An unknown size
can proceed with a clearly announced hard download cap.

Save the extraction result in tmpfs and reuse it with `--load-info-json` and
explicit selected format IDs, avoiding a second independent format choice.
Download each selected track sequentially to stdout and write it to tmpfs
through a byte-counting sink. Across all tracks, check each chunk before
writing and terminate the job if writing it would exceed `I`. Do not keep
the full source in a Bun buffer. yt-dlp `--max-filesize` is supplementary,
not the aggregate-size enforcement mechanism. Bound retained diagnostic
output and metadata size as well as media bytes.

Run yt-dlp from the private workspace. Use direct HTTP(S) or FFmpeg's
streaming HLS downloader so fragment staging cannot bypass the byte counter.
Skip source variants requiring native fragment staging. Replay the exact
format ID and omit `webpage_url` from replay JSON to prevent re-extraction
into a partially written output stream.

## Encoding and verification

Probe the completed source(s). If a complete, compatible MP4 (H.264,
`yuv420p`, AAC or no audio) already fits strictly below `limit`, reuse it.
If stream-copy remuxing alone produces such an MP4, prefer that over lossy
encoding. Any remux must complete and pass the same final checks.

Otherwise encode H.264 with libx264, `yuv420p`, AAC at 96 kbit/s when audio
exists, at most two codec threads and bounded filter threads, and MP4
`+faststart`. Remove ancillary streams and unneeded metadata. Limit output
to 30 fps without increasing lower source frame rates, preserve display
orientation/aspect ratio, use even dimensions, and never upscale.

```
videoBitsPerSecond = floor(targetBytes * 8 / durationSeconds)
                     - (hasAudio ? 96_000 : 0)
```

Use two-pass average-bitrate encoding with pass logs in tmpfs. Proposed
quality tiers are 720p for video bitrate >= 1.2 Mbit/s, 480p for >= 0.6
Mbit/s, and 360p otherwise (shorter dimension, preserving orientation).
Reject a calculated video budget below 150 kbit/s instead of silently
cutting the film or dropping audio. These thresholds are policy defaults.

Measure output after FFmpeg finishes and finalizes `faststart`. If too big,
delete that attempt and allow one full retry with a smaller target derived
from measured overshoot and an additional margin. There are at most two
encoding attempts. If neither fits or the deadline is exhausted, explain
the failure and send no incomplete or oversized attachment.

## Progress and errors

One deferred reply is edited in place, at most every two seconds; edits are
serialized and intermediate updates coalesced. Before the terminal response,
close the reporter and await in-flight edits so stale progress cannot
overwrite the result. Escape source titles and disable allowed mentions.

Stages and examples:

```
Sprawdzam film i dostępny RAM…
Pobieram: 42% · 31,2 / ~74,0 MB · 2,8 MB/s · pozostało ~15 s
Pobieram: 31,2 MB · rozmiar nieznany · limit pobierania 180,0 MB
Analizuję obraz: 68% · przebieg 1/2
Koduję: 37% · przebieg 2/2 · 720p
Ponawiam kodowanie: plik przekroczył limit · próba 2/2
Sprawdzam rozmiar i kompletność filmu…
Wysyłam: 18,74 MB / limit 20,00 MB
Gotowe! 01:24 · 1280×720 · 18,74 MB
```

Parse yt-dlp's machine-oriented progress template; distinguish exact totals,
estimated totals, and unknown totals. Aggregate progress across separate
tracks when totals exist. Parse FFmpeg `-progress` time and speed for each
pass; clearly identify pass/attempt rather than inventing a single overall
percentage. Report upload as a stage without a fabricated percentage.

Errors distinguish invalid input, no suitable format, source over budget,
insufficient memory/tmpfs, downloader failure, encoder failure, deadline,
final-size/validation failure, and Discord upload failure. Do not expose
raw subprocess stderr, metadata, or signed source URLs to users or logs.
Use `createLogger('save')` with bounded, redacted diagnostic information.

## Deadlines and cleanup

Measure time from invocation using a monotonic clock. Reserve a ten-minute
processing budget including metadata, download, and attempts, and a bounded
upload window leaving room before Discord's fifteen-minute token expiry.
Bound individual metadata extraction to 45 seconds and each downloader or
encoder invocation to three minutes or the remaining processing budget,
whichever is shorter. Use a bounded upload request/retry policy; no new
encoding attempt starts without time left. Upload failure is terminal.

Own subprocess lifecycles in a save service. On completion, error, timeout,
or shutdown, terminate the process group (including downloader descendants),
wait for exit with a bounded SIGKILL fallback, stop timers, and clean up
the workspace after the last reader/upload settles. Handle SIGINT/SIGTERM
through the existing shutdown path before `process.exit`. Release the busy
slot in all cases. Failure must not affect playback or booting the bot.

## Code boundaries and documentation

- `src/commands/save.ts`: slash definition, Discord replies, attachment
  delivery, and service orchestration. Register only in `commands/index.ts`.
- `src/save/`: typed metadata/format selection, limits/admission, process
  lifecycle, bounded downloading, encoding, and progress events, with no
  dependency on Discord interaction objects. Keep the split proportionate;
  no generic plugin or job framework.
- Add a lazy optional `save` section loader for `config.json`, defaulting
  when the file/section is absent. Expose only host knobs `tmpfsDir` (optional
  override, still verified), `maxInputBytes` (default 268435456), and
  `memoryReserveBytes` (default 536870912). Validate overrides when `/save`
  is invoked; retain output hard limit and other policy defaults in code.
- Update `config.example.json`, README, and AGENTS command/architecture notes
  to describe `/save`, tmpfs, ffprobe, limits, progress, and cleanup behavior.
  No HTTP endpoints change; `docs/API.md` and OpenAPI remain outside scope.

## Verification required before implementation is called complete

Run `bun x tsc -p tsconfig.json --noEmit`. Exercise real local FFmpeg and
ffprobe with short synthetic media: audio and silent video, portrait and
rotated video, seek-requiring MP4, remux/no-transcode case, forced oversize
retry, and preserved duration. Verify the strict byte boundary, aggregate
source cap with unknown/misreported sizes, resource/deadline failures,
subprocess cleanup, slot release, and progress-finalization ordering using
focused checks and controlled subprocesses where necessary.

Manual Discord checks require a test guild/token: registration, progress,
successful attachment delivery, busy reply, download failure, upload
failure, and SIGINT cleanup while work is active. If those credentials or
a guild are unavailable, explicitly report that validation gap.

## References

- Project: AGENTS.md, RULES.md, src/commands/togif.ts, src/config.ts,
  src/commands/types.ts, src/index.ts, src/bot.ts.
- https://github.com/yt-dlp/yt-dlp#readme
- https://ffmpeg.org/ffmpeg.html
- https://ffmpeg.org/ffmpeg-formats.html
- https://docs.discord.com/developers/interactions/receiving-and-responding
- https://docs.kernel.org/filesystems/tmpfs.html
- https://docs.kernel.org/admin-guide/cgroup-v2.html
