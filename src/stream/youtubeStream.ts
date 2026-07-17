import {createAudioResource, StreamType} from '@discordjs/voice';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Readable} from 'node:stream';

import {DiscordBot} from '../bot';
import {config} from '../config';
import {createLogger} from '../logger';
import type {YtVideo} from './types';

const log = createLogger('ytdlp');

// Safety cap on how long waitForExit() will wait for the child processes to
// report 'close' before giving up — SIGKILL is near-instant in practice, so
// this should only ever bite if something is very wrong.
const EXIT_WAIT_TIMEOUT_MS = 2_000;

// Pipes yt-dlp's audio output through ffmpeg (resample + volume normalize)
// into a readable Opus stream that @discordjs/voice can consume directly.
class YtDlpReadable extends Readable {
  private process?: ChildProcessWithoutNullStreams;
  private ffmpegProcess?: ChildProcessWithoutNullStreams;
  private readonly video: YtVideo;
  private exited: Promise<unknown> = Promise.resolve();

  constructor(video: YtVideo) {
    super();
    this.video = video;
  }

  start() {
    log.info(`Starting yt-dlp stream for URL: ${this.video.url}`);

    this.process = spawn('yt-dlp', [
      '-f',
      config.ytDlp.format,
      '--no-playlist',
      '--no-warnings',
      '--geo-bypass',
      '--js-runtimes',
      'bun',
      '--audio-format',
      'm4a',
      '--audio-quality',
      config.ytDlp.audioQuality,
      '--limit-rate',
      config.ytDlp.limitRate,
      '-o',
      '-',
      this.video.url,
    ]);

    this.ffmpegProcess = spawn('ffmpeg', [
      '-i', 'pipe:0',  // Input from yt-dlp
      // Seek start time if provided (placed after -i for accuracy)
      ...(this.video.startSeconds !== undefined ?
              ['-ss', `${this.video.startSeconds}`] :
              []),
      '-vn',              // No video
      '-ac', '2',         // Force 2 channels (Stereo)
      '-ar', '48000',     // Force 48kHz sample rate
      '-c:a', 'libopus',  // Encode to Opus
      '-b:a', '96k',      // Target bitrate 96 kbits/s
      '-filter:a', 'volume=0.25', '-loglevel', 'warning',  // Reduce log spam
      '-f', 'opus',                                        // Output Opus stream
      'pipe:1'                                             // Output to stdout
    ]);

    // Resolves once both children have actually exited — see waitForExit().
    this.exited = Promise.all(
        [once(this.process, 'close'), once(this.ffmpegProcess, 'close')]);

    // Do NOT throttle ffmpeg with '-re' — let the Discord AudioPlayer handle
    // pacing itself.
    this.process.stdout.pipe(this.ffmpegProcess.stdin);

    this.ffmpegProcess.stdout.on('data', (chunk) => {
      // Respect backpressure: if the internal buffer is full, pause the
      // source until _read() signals the consumer wants more. Without this,
      // a stalled consumer (e.g. a voice reconnect) lets ffmpeg keep
      // flooding an unbounded internal buffer.
      if (!this.push(chunk)) this.ffmpegProcess?.stdout.pause();
    });

    this.ffmpegProcess.stdout.on('end', () => {
      log.info(`Stream ended for URL: ${this.video.url}`);
      this.push(null);
    });

    this.process.on('error', (err) => {
      log.error('yt-dlp process error:', err);
      if (this.ffmpegProcess && !this.ffmpegProcess.killed)
        this.ffmpegProcess.kill();
      this.destroy(err);
    });

    this.ffmpegProcess.on('error', (err) => {
      log.error('ffmpeg process error:', err);
      this.destroy(err);
    });

    this.process.on('close', (code) => {
      if (code !== 0) log.warn(`yt-dlp exited with code ${code}`);
      this.ffmpegProcess?.stdin.end();
    });

    this.ffmpegProcess.on('close', (code) => {
      if (code !== 0) log.warn(`ffmpeg exited with code ${code}`);
    });
  }

  override _read() {
    // Consumer wants more data — resume a source paused for backpressure.
    this.ffmpegProcess?.stdout.resume();
  }

  override _destroy(err: Error|null, callback: (error?: Error|null) => void) {
    this.process?.stdout.unpipe();
    this.ffmpegProcess?.stdin.end();

    if (this.process && !this.process.killed) this.process.kill('SIGKILL');
    if (this.ffmpegProcess && !this.ffmpegProcess.killed)
      this.ffmpegProcess.kill('SIGKILL');

    this.process = undefined;
    this.ffmpegProcess = undefined;

    callback(err);
  }

  // Resolves once both child processes have exited (or after a safety
  // timeout). Call after destroy() so the caller can be sure the old
  // pipeline is fully gone before starting a new one.
  async waitForExit(): Promise<void> {
    await Promise.race([
      this.exited,
      new Promise(resolve => setTimeout(resolve, EXIT_WAIT_TIMEOUT_MS)),
    ]);
  }
}

// One playable instance of a queued video. Owns the yt-dlp/ffmpeg pipeline
// and the Discord audio resource built from it.
export class YoutubeStream {
  readonly video: YtVideo;
  private readonly source: YtDlpReadable;

  constructor(video: YtVideo) {
    this.video = video;
    this.source = new YtDlpReadable(video);
  }

  start() {
    this.source.start();
    const resource = createAudioResource(
        this.source, {inputType: StreamType.Arbitrary});
    DiscordBot.player.play(resource);
  }

  async stop() {
    this.source.destroy();
    DiscordBot.player.stop();
    await this.source.waitForExit();
  }
}
