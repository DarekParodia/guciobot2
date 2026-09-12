import {AttachmentBuilder, SlashCommandBuilder} from 'discord.js';
import type {Attachment, ChatInputCommandInteraction} from 'discord.js';
import {spawn} from 'node:child_process';
import {createWriteStream} from 'node:fs';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {extname, join, parse} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

import {createLogger} from '../logger';

import type {Command} from './types';

const log = createLogger('togif');

// Discord's attachment limit is 10MB; keep a bit of headroom.
const MAX_GIF_SIZE = 9.5 * 1000000;
// A GIF within this much of MAX_GIF_SIZE is "good enough" — stop searching.
const ACCEPTABLE_MARGIN = 1.0 * 1000000;
// Size the width search aims for: the middle of the acceptable band.
const TARGET_GIF_SIZE = MAX_GIF_SIZE - ACCEPTABLE_MARGIN / 2;
// The input is stored in os.tmpdir(), which is often a RAM-backed tmpfs.
const MAX_INPUT_SIZE = 100 * 1000000;
const MAX_TRIES = 8;
const MIN_WIDTH = 16;
const DEFAULT_FPS = 15;
const PALETTE_COLORS = 256;
// Fewer decoder threads means fewer frames buffered at once; GIF encoding is
// single-threaded anyway, so this costs next to no speed.
const FFMPEG_THREADS = '2';
// A single ffmpeg run that takes longer than this is killed.
const PROCESS_TIMEOUT_MS = 5 * 60 * 1000;
// Interaction tokens expire 15 minutes after the command was invoked; stop
// searching well before that and send the best GIF found so far.
const SEARCH_BUDGET_MS = 10 * 60 * 1000;
const PROGRESS_EDIT_INTERVAL_MS = 1500;

interface MediaInfo {
  // Display dimensions, i.e. after applying rotation metadata — the frame
  // size ffmpeg's filters actually see (autorotate is on by default).
  width: number;
  height: number;
  durationSeconds: number|null;
}

interface Attempt {
  width: number;
  size: number;
}

type ProgressReporter = ReturnType<typeof createProgressReporter>;

function formatMb(bytes: number): string {
  return `${(bytes / 1000000).toFixed(1)} MB`;
}

// Renders run one at a time: each ffmpeg run takes a couple hundred MB of
// RAM, and concurrent /togif calls would multiply that.
let renderChain: Promise<void> = Promise.resolve();
let rendersInFlight = 0;

async function withRenderSlot<T>(
    onQueued: (ahead: number) => void, fn: () => Promise<T>): Promise<T> {
  const ahead = rendersInFlight++;
  if (ahead > 0) onQueued(ahead);
  const previous = renderChain;
  const slot = Promise.withResolvers<void>();
  renderChain = slot.promise;
  try {
    await previous;
    return await fn();
  } finally {
    rendersInFlight--;
    slot.resolve();
  }
}

// Runs a process to completion. Rejects on a non-zero exit (with the tail of
// stderr in the message) and kills the process if it exceeds
// PROCESS_TIMEOUT_MS, so a stuck ffmpeg can never hang the command forever.
function runProcess(
    command: string, args: string[],
    onStdoutLine?: (line: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '';
    let stderr = '';
    let pendingLine = '';

    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${PROCESS_TIMEOUT_MS}ms`));
    }, PROCESS_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      if (!onStdoutLine) return;
      const lines = (pendingLine + text).split('\n');
      pendingLine = lines.pop() ?? '';
      for (const line of lines) onStdoutLine(line.trim());
    });
    // Always drain stderr: an unread pipe fills up and blocks ffmpeg.
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(
            `${command} exited with code ${code}: ${stderr.trim().slice(-500)}`));
      }
    });
  });
}

async function probeMedia(inputPath: string): Promise<MediaInfo> {
  const output = await runProcess('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=width,height:stream_side_data=rotation:format=duration', '-of',
    'json', inputPath
  ]);
  const data = JSON.parse(output) as {
    streams?: {
      width?: number;
      height?: number;
      side_data_list?: {rotation?: number}[];
    }[];
    format?: {duration?: string};
  };

  const stream = data.streams?.[0];
  if (!stream?.width || !stream.height) {
    throw new Error('ffprobe found no video stream');
  }

  const rotation = stream.side_data_list?.find(
                       (sd) => sd.rotation !== undefined)?.rotation ??
      0;
  const rotated = Math.abs(rotation) % 180 === 90;
  const duration = Number(data.format?.duration);

  return {
    width: rotated ? stream.height : stream.width,
    height: rotated ? stream.width : stream.height,
    durationSeconds: Number.isFinite(duration) && duration > 0 ? duration : null,
  };
}

// Renders the input to `outputPath` at the given width and returns the GIF's
// size in bytes. Two passes on purpose: a single-pass
// `split,palettegen,paletteuse` graph has to hold every decoded frame in RAM
// until the palette is ready (~1.3GB for 27s of 1280x576), while two passes
// stream frame by frame at a flat ~150MB. `onProgress` gets the fraction
// (0-1) of the second pass done; the first pass can't report any.
async function renderGif(
    inputPath: string, workDir: string, outputPath: string, width: number,
    fps: number, singleFrame: boolean, durationSeconds: number|null,
    onProgress: (fraction: number) => void): Promise<number> {
  const palettePath = join(workDir, 'palette.png');
  // min(iw, …) guarantees we never upscale, even if the probed width is off.
  const prepare = `${singleFrame ? '' : `fps=${fps},`}scale='min(iw,${
      width})':-1:flags=lanczos`;
  // Reading from a file (not stdin) lets ffmpeg seek, which MP4/MOV files
  // with the moov atom at the end (most phone recordings) require.
  const input = ['-threads', FFMPEG_THREADS, '-i', inputPath];

  await runProcess('ffmpeg', [
    '-v', 'error', '-nostats', '-y', ...input, '-vf',
    `${prepare},palettegen=max_colors=${PALETTE_COLORS}`, '-update', '1',
    palettePath
  ]);

  await runProcess(
      'ffmpeg',
      [
        '-v', 'error', '-nostats', '-progress', 'pipe:1', '-y', ...input, '-i',
        palettePath, '-filter_complex', `[0:v]${prepare}[x];[x][1:v]paletteuse`,
        ...(singleFrame ? ['-frames:v', '1'] : []), '-f', 'gif', outputPath
      ],
      (line) => {
        if (!durationSeconds || !line.startsWith('out_time_us=')) return;
        const outTimeUs = Number(line.slice('out_time_us='.length));
        if (!Number.isFinite(outTimeUs)) return;
        onProgress(Math.min(1, Math.max(0, outTimeUs / (durationSeconds * 1e6))));
      });

  return (await stat(outputPath)).size;
}

// Picks the next width to try, or null once the search has converged.
// `fits`/`tooBig` bracket the answer: the widest GIF known to fit and the
// narrowest known to be too big.
function nextWidth(
    last: Attempt, fitsWidth: number, tooBigWidth: number,
    maxWidth: number): number|null {
  const high = Math.min(tooBigWidth, maxWidth + 1);
  const minStep = Math.max(2, Math.round(maxWidth * 0.01));
  if (high - fitsWidth <= minStep) return null;

  // GIF size grows roughly with pixel count, i.e. with width squared.
  let candidate =
      Math.round(last.width * Math.sqrt(TARGET_GIF_SIZE / last.size));
  if (candidate <= fitsWidth || candidate >= high) {
    candidate = Math.floor((fitsWidth + high) / 2);
  }
  if (candidate < MIN_WIDTH) {
    // Nothing fits yet: give the smallest width one shot before giving up.
    return tooBigWidth > MIN_WIDTH ? MIN_WIDTH : null;
  }
  return candidate;
}

// Edits the deferred reply with the latest progress text, at most once per
// PROGRESS_EDIT_INTERVAL_MS (Discord rate-limits edits). The most recent
// update is always sent eventually, unless `close()` is called first.
function createProgressReporter(interaction: ChatInputCommandInteraction) {
  let lastEditAt = 0;
  let queued: string|null = null;
  let inFlight: Promise<void>|null = null;
  let timer: ReturnType<typeof setTimeout>|null = null;

  const send = () => {
    timer = null;
    if (queued === null) return;
    const content = queued;
    queued = null;
    lastEditAt = Date.now();
    inFlight =
        interaction.editReply(content)
            .then(() => undefined)
            .catch((err) => log.warn('Failed to edit progress message:', err))
            .finally(() => {
              inFlight = null;
              schedule();
            });
  };

  const schedule = () => {
    if (timer || inFlight || queued === null) return;
    const wait =
        Math.max(0, lastEditAt + PROGRESS_EDIT_INTERVAL_MS - Date.now());
    timer = setTimeout(send, wait);
  };

  return {
    update(content: string) {
      queued = content;
      schedule();
    },
    // Drops any pending update and waits for an in-flight one, so the final
    // reply can't be overwritten by a stale progress edit.
    async close() {
      queued = null;
      if (timer) clearTimeout(timer);
      timer = null;
      await inFlight;
    },
  };
}

function describeAttempts(attempts: Attempt[]): string[] {
  return attempts.map(
      (a, i) => `Próba ${i + 1}: ${a.width} px → ${formatMb(a.size)} ${
          a.size <= MAX_GIF_SIZE ? '✅' : '❌ za duży'}`);
}

// Streams the attachment straight to disk instead of buffering it in memory.
async function downloadAttachment(url: string, path: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Attachment download failed: HTTP ${res.status}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(path));
}

async function generateGif(
    interaction: ChatInputCommandInteraction, attachment: Attachment,
    fps: number, singleFrame: boolean, progress: ProgressReporter) {
  const workDir = await mkdtemp(join(tmpdir(), 'togif-'));
  try {
    progress.update('Pobieram plik...');
    const ext = extname(attachment.name);
    const inputPath =
        join(workDir, `input${/^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : ''}`);
    const outputPath = join(workDir, 'output.gif');
    await downloadAttachment(attachment.url, inputPath);

    let media: MediaInfo;
    try {
      media = await probeMedia(inputPath);
    } catch (err) {
      log.warn(`Could not probe ${attachment.name}:`, err);
      await progress.close();
      await interaction.editReply(
          'Nie umiem odczytać tego pliku — to na pewno zdjęcie albo filmik?');
      return;
    }

    const header = `Generuję gifa z **${attachment.name}** (${media.width}×${
        media.height}${
        singleFrame || !media.durationSeconds ?
            '' :
            `, ${media.durationSeconds.toFixed(1)} s, ${fps} fps`})`;
    log.info(`Rendering ${attachment.name}: ${media.width}x${
        media.height}, duration ${media.durationSeconds}s, ${fps} fps`);

    const attempts: Attempt[] = [];
    let best: {width: number, gif: Buffer}|null = null;
    let tooBigWidth = Infinity;
    let width: number|null = media.width;

    while (width !== null && attempts.length < MAX_TRIES) {
      // Measured from the invocation, so time spent queued counts too.
      if (Date.now() - interaction.createdTimestamp > SEARCH_BUDGET_MS) {
        log.warn('Search budget exceeded, stopping early');
        break;
      }

      const attemptWidth: number = width;
      const status = (detail: string) => [
        header, ...describeAttempts(attempts),
        `⏳ Próba ${attempts.length + 1}: ${attemptWidth} px — ${detail}`
      ].join('\n');

      progress.update(status('analiza kolorów...'));
      const size = await renderGif(
          inputPath, workDir, outputPath, attemptWidth, fps, singleFrame,
          media.durationSeconds,
          (fraction) =>
              progress.update(status(`${Math.round(fraction * 100)}%`)));

      const attempt = {width: attemptWidth, size};
      attempts.push(attempt);
      log.info(`Attempt ${attempts.length}/${MAX_TRIES}: width ${
          attemptWidth} -> ${formatMb(size)}`);

      if (size <= MAX_GIF_SIZE) {
        // Only GIFs that fit are loaded into memory; the next attempt
        // overwrites outputPath.
        best = {width: attemptWidth, gif: await readFile(outputPath)};
        // Full resolution already fits: never try to make it bigger.
        if (attemptWidth >= media.width) break;
        if (size >= MAX_GIF_SIZE - ACCEPTABLE_MARGIN) break;
      } else {
        tooBigWidth = attemptWidth;
      }

      width = nextWidth(attempt, best?.width ?? 0, tooBigWidth, media.width);
    }

    await progress.close();

    if (!best) {
      await interaction.editReply([
        header, ...describeAttempts(attempts),
        attempts.length === 0 ?
            'Za długo czekałem w kolejce, spróbuj ponownie.' :
            'Nie udało się zmieścić gifa w limicie 10MB. Spróbuj z krótszym lub mniejszym plikiem.'
      ].join('\n'));
      return;
    }

    const replyAttachment = new AttachmentBuilder(
        best.gif, {name: `${parse(attachment.name).name}.gif`});

    await interaction.editReply({
      content: `Gotowe! ${best.width}×${
          Math.round(best.width * media.height / media.width)}, ${
          formatMb(best.gif.length)} (prób: ${attempts.length})`,
      files: [replyAttachment],
    });
  } finally {
    await rm(workDir, {recursive: true, force: true});
  }
}

export const togif: Command = {
  data: new SlashCommandBuilder()
            .setName('togif')
            .setDescription('Generuje gifa ze zdjęcia bądź filmu')
            .addAttachmentOption(
                (option) =>
                    option.setRequired(true).setName('media').setDescription(
                        'Zdjecie lub filmik'))
            .addNumberOption(
                (option) => option.setRequired(false)
                                .setName('fps')
                                .setDescription(`Ile fps ma miec gif`)
                                .setMaxValue(30)
                                .setMinValue(5)),
  execute: async (interaction) => {
    const attachment = interaction.options.getAttachment('media');
    const fps = interaction.options.getNumber('fps') ?? DEFAULT_FPS;

    if (!attachment || !attachment.width || !attachment.height) {
      await interaction.reply({
        content:
            `Sorki ale nie przeslales zdjecia albo cos zlego jest ze zdjeciem :((`,
        ephemeral: true
      });
      return;
    }

    if (attachment.size > MAX_INPUT_SIZE) {
      await interaction.reply({
        content: `Plik jest za duży (${formatMb(attachment.size)}), max to ${
            formatMb(MAX_INPUT_SIZE)}.`,
        ephemeral: true
      });
      return;
    }

    // Still images become a single-frame GIF; animated GIFs are treated like
    // video so they keep their animation.
    const contentType = attachment.contentType ?? '';
    const singleFrame =
        contentType.startsWith('image/') && contentType !== 'image/gif';

    await interaction.deferReply();
    const progress = createProgressReporter(interaction);

    try {
      await withRenderSlot(
          (ahead) => progress.update(
              `Czekam w kolejce, przede mną ${ahead} ${
                  ahead === 1 ? 'gif' :
                                ahead < 5 ? 'gify' :
                                            'gifów'}...`),
          () => generateGif(
              interaction, attachment, fps, singleFrame, progress));
    } catch (e) {
      log.error('Error while generating GIF:', e);
      await progress.close();
      await interaction.editReply(
          'Wystąpił błąd podczas generowania gifa. Spróbuj ponownie później.');
    }
  },
};
