# Save video Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Track completed tasks and checks below.

**Goal:** Deliver the approved Linux tmpfs `/save` command with strict byte limits and useful progress.

**Architecture:** A thin Discord command calls a dedicated save service. Typed policy, Linux resource inspection, bounded subprocess execution, and media processing remain independent of Discord. The service holds its single job slot through upload and cleans up on shutdown.

**Tech Stack:** Bun, strict TypeScript, discord.js REST, yt-dlp, FFmpeg/ffprobe, Linux tmpfs/cgroups; no added dependencies.

**Spec:** `docs/superpowers/specs/2026-11-10-save-video-design.md` (approved by user).

## Global Constraints

- Final size strictly below `min(20_000_000, interaction.attachmentSizeLimit)`; target 95%.
- Verified tmpfs; aggregate source cap 268435456 bytes, memory reserve 536870912 bytes, configurable lazily.
- One active save including upload; no waiting queue. Source checks and actual-byte enforcement are both required.
- H.264/AAC MP4, full duration, two-pass compression when needed, at most two attempts.
- Two-second serialized progress edits, ten-minute processing budget, bounded upload.
- Kill child process groups and await cleanup on errors, deadlines and SIGINT/SIGTERM.
- Preserve existing `togif.ts` edits and keep playback independent.

## Review Focus

- Download size may be unknown or dishonest: actual bytes across tracks must stay bounded.
- Host RAM may exceed container allowance: cgroup ancestors must constrain admission.
- Ordinary MP4 may need seeks: real local media checks must use seekable tmpfs files.
- Progress edits and upload may race: close progress before terminal response; release resources after upload settles.
- A killed downloader may spawn descendants: terminate the process group on timeout/abort, including shutdown.

### Task 1: Policy and Linux resources

**Files:** Create `src/save/policy.ts`, `src/save/resources.ts`, `src/save/errors.ts`, `src/save/policy.test.ts`, `src/save/resources.test.ts`.

**Interfaces:** `getOutputLimit(number): number`; `parseSaveConfig(unknown): SaveConfig`; `selectFormats(metadata, inputLimit): Selection`; `encodingPlan(duration, hasAudio, target): EncodingPlan`; `getMemoryHeadroom(): Promise<number>`; `createWorkspace(config, limit): Promise<Workspace>`.

- [x] Write failing behavior checks for strict size/invalid limits, default and invalid config, selected-track size summation, smaller-format fallback, unknown sizes, low bitrate, ancestor RAM caps, tmpfs validation and source budget.
- [x] Run `bun test src/save/policy.test.ts src/save/resources.test.ts`; observe missing-feature failures.
- [x] Implement policy/config/errors and Linux resource inspection with injectable filesystem reader for cgroup fixtures.
- [x] Run both test files and inspect output.

### Task 2: Processes and progress

**Files:** Create `src/save/process.ts`, `src/save/progress.ts`, and corresponding `.test.ts` files.

**Interfaces:** `SaveJob.run(command, args, options): Promise<Buffer>` with bounded stdout or async sink, progress lines, abort/deadline support; `SaveJob.close(): Promise<void>`; `createProgressReporter(send, intervalMs)` with `update` and async `close`.

- [x] Write failing checks using real subprocesses for byte-cap enforcement before writing, nonzero exit, deadline/abort, descendants, serialized progress and finalization.
- [x] Run these tests and observe failures before implementation.
- [x] Implement process-group ownership, bounded drains, monitored jobs and coalescing progress.
- [x] Run these tests and inspect output.

### Task 3: Media and service lifecycle

**Files:** Create `src/save/media.ts`, `src/save/service.ts`, `src/save/media.test.ts`, `src/save/service.test.ts`.

**Interfaces:** `prepareVideo(job, url, limit, onProgress): Promise<SavedVideo>`; `withSavedVideo(url, discordLimit, onProgress, deliver, startedAt): Promise<void>`; `shutdownSaves(): Promise<void>`. `deliver` receives the verified result and an abort signal with an upload deadline.

- [x] Write failing real FFmpeg checks for compatible reuse, remux, two-pass encoding, silent/audio, portrait/rotation, seek-requiring MP4, exact boundaries, retry, and duration. Use controlled local yt-dlp/HTTP inputs where feasible.
- [x] Add busy/failed-delivery/shutdown checks around the real service lifecycle with an injected preparer only at the external media boundary.
- [x] Run checks to observe feature absence, then implement metadata locking, sequential capped downloads, probing, remux/encoding/retry, resource monitor and lifecycle.
- [x] Run all `src/save` tests and type-check.

### Task 4: Discord integration and documentation

**Files:** Implement existing `src/commands/save.ts`; modify `src/commands/index.ts`, `src/index.ts`, README.md, AGENTS.md, config.example.json; add command-boundary checks where meaningful.

- [x] Verify failure and result message formatting/progress includes effective limits and no stale writes; test upload cancellation at the HTTP boundary without a real Discord token.
- [x] Register command, implement bounded REST attachment upload with signal and no retries, wire shutdown and preserve first dotenv import.
- [x] Document tmpfs/config/limits/dependencies and verification commands.
- [x] Run `bun test src/save` and `bun x tsc -p tsconfig.json --noEmit`, inspect changes and have one fresh agent review the complete implementation.
- [x] Fix important findings with regression checks; report real-Discord validation gap without sending messages or logging in with local credentials.

## Execution record

- Baseline: type-check failed at src/index.ts:25/26 because Bun's Process.on augmentation shadows Node signal overloads. Signal registration through `node:events` `once` resolves the error.
- Execution: native implementation in the supplied checkout, preserving uncommitted user work. No commits, branch changes or additional approval round; user already approved implementation. No dependency install needed.
- Pre-flight: Task 3 consumes Task 1 policy/resources and Task 2 job/progress. Task 4 consumes Task 3 service. Interfaces agree on integer bytes, monotonic deadlines and cleanup awaiting delivery.
- Task 1: policy/resource tests RED (missing modules) -> GREEN, 9 checks. Host/cgroup limits, exact boundaries, source format fallback and private workspace covered.
- Task 2: process/progress tests RED -> GREEN, 6 checks. Sandbox rejects Bun child stdout writes with EPERM; the same tests pass outside sandbox with approved `bun test` permission.
- Task 3: media and service checks passed. The FFmpeg 9 fixture uses `-display_rotation`. Service tests observe pending delivery failures after releasing their delivery barrier.
- Task 4: command registration, documentation and local REST delivery verified. Type-check passed.
- Review fixes: stream HLS with FFmpeg in the workspace, skip native fragment formats, lock replay to a literal format ID, disable re-extraction, cap playlist metadata expansion, preserve Matroska track durations and handle cgroup v2 delegation and read failures. Progress edits are best effort. Regression checks reproduce the format ID, memory controller and track-duration failures.
- Final verification: `bun test src/save` passed all 33 tests. `bun x tsc -p tsconfig.json --noEmit` and `git diff --check` passed. The command registry includes `/save url`. Live Discord delivery and shutdown during real playback require a test guild.
