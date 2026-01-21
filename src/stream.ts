import {createAudioResource, StreamType} from '@discordjs/voice';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';

import {DiscordBot} from './Discord';

var currentStream: YoutubeStream|null = null;
var streamQueue: string[] = [];
var maxQueueSize = 15;
var isPlaying = false;

var onStartCallbacks: Array<() => void> = [];
var onEndCallbacks: Array<() => void> = [];

export class YtDlpReadable extends Readable {
  private process?: ChildProcessWithoutNullStreams;
  private ffmpegProcess?: ChildProcessWithoutNullStreams;
  private url: string;

  constructor(url: string) {
    super();
    this.url = url;
  }

  async play() {
    console.log(`Starting yt-dlp stream for URL: ${this.url}`);
    isPlaying = true;

    this.process = spawn('yt-dlp', [
      '-f',
      // Prefer audio formats with bitrate <= 64k, fall back to best audio
      'bestaudio[abr<=64]/bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--geo-bypass',
      '--audio-format',
      'm4a',
      '--audio-quality',
      '64K',
      '--limit-rate',
      '64K',
      '-o',
      '-',
      this.url,
    ]);

    // CORRECTION HERE:
    this.ffmpegProcess = spawn('ffmpeg', [
      '-i', 'pipe:0',     // Input from yt-dlp
      '-vn',              // No video
      '-ac', '2',         // Force 2 channels (Stereo)
      '-ar', '48000',     // Force 48kHz sample rate
      '-c:a', 'libopus',  // Encode to Opus
      '-b:a', '64k',      // Target bitrate 64 kbits/s
      '-filter:a', 'volume=0.25', '-loglevel', 'warning',  // Reduce log spam
      '-f', 'opus',                                        // Output Opus stream
      'pipe:1'                                             // Output to stdout
    ]);

    // NOTE: Removed '-re'.
    // Do NOT throttle FFmpeg. Let the Discord AudioPlayer handle the timing.

    this.process.stdout.pipe(this.ffmpegProcess.stdin);

    this.ffmpegProcess.stdout.on('data', (chunk) => {
      // You can comment this out to reduce console spam once it works
      console.log(`FFmpeg output: ${chunk.length} bytes`);

      // Push data to the readable stream
      // If push returns false, we should ideally pause, but for
      // this simple implementation, we just push.
      this.push(chunk);
    });

    this.ffmpegProcess.stdout.on('end', () => {
      console.log(`Stream ended for URL: ${this.url}`);
      this.push(null);

      isPlaying = false;

      for (const callback of onEndCallbacks) {
        callback();
      }
    });

    // ... (rest of your error handling remains the same) ...

    // Ensure you handle the case where yt-dlp fails immediately
    this.process.on('error', (err) => {
      console.error('yt-dlp process error:', err);
      if (this.ffmpegProcess && !this.ffmpegProcess.killed)
        this.ffmpegProcess.kill();
      this.destroy(err);
    });

    this.ffmpegProcess.on('error', (err) => {
      console.error('ffmpeg process error:', err);
      this.destroy(err);
    });

    // Ensure to clean up ffmpeg on class destroy
    this.process.on('close', (code) => {
      if (code !== 0) console.log(`yt-dlp exited with code ${code}`);
      if (this.ffmpegProcess) this.ffmpegProcess.stdin.end();
    });

    this.ffmpegProcess.on('close', (code) => {
      if (code !== 0) console.log(`ffmpeg exited with code ${code}`);
    });

    for (const callback of onStartCallbacks) {
      callback();
    }
  }

  override _read() {
    // No-op — data is pushed from the child process
  }

  override _destroy(err: Error|null, callback: (error?: Error|null) => void) {
    // 1. Close pipes to stop data flow
    this.process?.stdout.unpipe();
    this.ffmpegProcess?.stdin.end();

    // 2. Kill processes
    if (this.process && !this.process.killed) this.process.kill('SIGKILL');
    if (this.ffmpegProcess && !this.ffmpegProcess.killed)
      this.ffmpegProcess.kill('SIGKILL');

    // 3. Clear references for GC
    this.process = undefined;
    this.ffmpegProcess = undefined;

    callback(err);
  }
}
export class YoutubeStream {
  private url: string;
  private ytDlpStream: YtDlpReadable;

  constructor(url: string) {
    this.url = url;
    this.ytDlpStream = new YtDlpReadable(url);
  }

  async play() {
    const resource = createAudioResource(this.ytDlpStream, {
      inputType: StreamType.Arbitrary,  // Let discordjs detect Opus stream
    });
    DiscordBot.player.play(resource);
  }

  async start() {
    await this.ytDlpStream.play();
    await this.play();
  }

  async stop() {
    this.ytDlpStream.destroy();
    DiscordBot.player.stop();
  }
}

export async function queueYoutubeStream(url: string) {
  streamQueue.push(url);

  if (!isPlaying) {
    // If this is the first item in the queue, start playing it immediately
    await playNextYoutubeStream();
  }

  console.log(`YouTube stream queued: ${url}`);
}

export async function playNextYoutubeStream() {
  if (streamQueue.length === 0) {
    console.log('No more YouTube streams in the queue.');
    return;
  }

  const nextUrl = streamQueue.shift();
  if (nextUrl) {
    await playYoutubeStream(nextUrl);
  }
}

export async function playYoutubeStream(url: string) {
  if (currentStream) {
    await currentStream.stop();
  }
  console.log(`Starting YouTube stream for: ${url}`);
  currentStream = new YoutubeStream(url);
  await currentStream.start();
  console.log('YouTube stream started');
}

export async function addOnEndCallback(callback: () => Promise<void>) {
  onEndCallbacks.push(callback);
}

export async function addOnStartCallback(callback: () => Promise<void>) {
  onStartCallbacks.push(callback);
}

async function onEnd() {
  console.log('on end callback');
  await playNextYoutubeStream();
}

async function onStart() {
  console.log('on start callback');
}

addOnEndCallback(onEnd);
addOnStartCallback(onStart);