import {createAudioResource, StreamType} from '@discordjs/voice';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';

import {DiscordBot} from './Discord';

var currentStream: YoutubeStream|null = null;
var streamQueue: YtVideo[] = [];
var maxQueueSize = 15;
var isPlaying = false;

var onStartCallbacks: Array<() => void> = [];
var onEndCallbacks: Array<() => void> = [];

export interface YtVideo {
  url: string;
  title: string;
  duration: number;
  durationString: string;
  onEnd?: () => Promise<void>;
  onStart?: () => Promise<void>;
}

export class YtDlpReadable extends Readable {
  private process?: ChildProcessWithoutNullStreams;
  private ffmpegProcess?: ChildProcessWithoutNullStreams;
  private videoInfo: YtVideo;

  constructor(videoInfo: YtVideo) {
    super();
    this.videoInfo = videoInfo;

    let onEndTMP = async () => {
      await this.videoInfo.onEnd?.();
      removeOnEndCallback(onEndTMP);
    };
    addOnEndCallback(onEndTMP);

    let onStartTMP = async () => {
      await this.videoInfo.onStart?.();
      removeOnStartCallback(onStartTMP);
    };
    addOnStartCallback(onStartTMP);
  }

  async play() {
    console.log(`Starting yt-dlp stream for URL: ${this.videoInfo.url}`);
    this.process = spawn('yt-dlp', [
      '-f',
      // Prefer audio formats with bitrate <= 64k, fall back to best audio
      'bestaudio[abr<=96]/bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--geo-bypass',
      '--js-runtimes',
      'bun',
      '--audio-format',
      'm4a',
      '--audio-quality',
      '96K',
      '--limit-rate',
      '96K',
      '-o',
      '-',
      this.videoInfo.url,
    ]);

    // CORRECTION HERE:
    this.ffmpegProcess = spawn('ffmpeg', [
      '-i', 'pipe:0',     // Input from yt-dlp
      '-vn',              // No video
      '-ac', '2',         // Force 2 channels (Stereo)
      '-ar', '48000',     // Force 48kHz sample rate
      '-c:a', 'libopus',  // Encode to Opus
      '-b:a', '96k',      // Target bitrate 64 kbits/s
      '-filter:a', 'volume=0.25', '-loglevel', 'warning',  // Reduce log spam
      '-f', 'opus',                                        // Output Opus stream
      'pipe:1'                                             // Output to stdout
    ]);

    // NOTE: Removed '-re'.
    // Do NOT throttle FFmpeg. Let the Discord AudioPlayer handle the timing.

    this.process.stdout.pipe(this.ffmpegProcess.stdin);

    this.ffmpegProcess.stdout.on('data', (chunk) => {
      // You can comment this out to reduce console spam once it works
      // console.log(`FFmpeg output: ${chunk.length} bytes`);

      // Push data to the readable stream
      // If push returns false, we should ideally pause, but for
      // this simple implementation, we just push.
      this.push(chunk);
    });

    this.ffmpegProcess.stdout.on('end', () => {
      console.log(`Stream ended for URL: ${this.videoInfo.url}`);
      this.push(null);
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

    triggerOnStartCallbacks();
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
  private ytDlpStream: YtDlpReadable;
  private videoInfo: YtVideo;
  private resource: any;

  constructor(video: YtVideo) {
    this.videoInfo = video;
    this.ytDlpStream = new YtDlpReadable(video);
  }

  async play() {
    this.resource = createAudioResource(this.ytDlpStream, {
      inputType: StreamType.Arbitrary,  // Let discordjs detect Opus stream
    });
    DiscordBot.player.play(this.resource);
  }

  async start() {
    await this.ytDlpStream.play();
    await this.play();
  }

  async stop() {
    this.ytDlpStream.destroy();
    DiscordBot.player.stop();
  }

  async getVideoInfo(): Promise<YtVideo> {
    return this.videoInfo;
  }
}

export async function queueYoutubeStream(videoInfo: YtVideo) {
  streamQueue.push(videoInfo);

  if (!isPlaying) {
    console.log('is not playing');

    // If this is the first item in the queue, start playing it immediately
    await playNextYoutubeStream();
  }

  console.log(`YouTube stream queued: ${videoInfo.url}`);
}

export async function playNextYoutubeStream() {
  if (streamQueue.length === 0) {
    console.log('No more YouTube streams in the queue.');
    return;
  }

  const nextVideo = streamQueue.shift();
  if (nextVideo) {
    await playYoutubeStream(nextVideo);
  }
}

export async function playYoutubeStream(video: YtVideo) {
  if (currentStream) {
    await currentStream.stop();
  }

  currentStream = null;
  currentStream = new YoutubeStream(video);
  await currentStream.start();
}

export async function queryVideoInfo(url: string): Promise<YtVideo> {
  return new Promise<YtVideo>((resolve, reject) => {
    const ytDlpProcess = spawn('yt-dlp', [
      '--no-playlist',
      '--no-warnings',
      '--geo-bypass',
      '--js-runtimes',
      'bun',
      '-j',  // Output video info in JSON
      url,
    ]);

    let output = '';
    ytDlpProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlpProcess.stderr.on('data', (data) => {
      console.error(`yt-dlp error: ${data}`);
    });

    ytDlpProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }
      try {
        const info = JSON.parse(output);
        const video: YtVideo = {
          url: info.webpage_url,
          title: info.title,
          duration: info.duration,
          durationString: info.duration_string,
        };
        resolve(video);
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function getQueueSize(): Promise<Number> {
  return streamQueue.length;
}

export async function getQueue(): Promise<YtVideo[]> {
  return streamQueue;
}

export async function getCurrentStream(): Promise<YoutubeStream|null> {
  return currentStream;
}

export async function isSteamPlaying(): Promise<Boolean> {
  return isPlaying;
}

export async function addOnEndCallback(callback: () => Promise<void>) {
  onEndCallbacks.push(callback);
}

export async function addOnStartCallback(callback: () => Promise<void>) {
  onStartCallbacks.push(callback);
}

export async function removeOnEndCallback(callback: () => Promise<void>) {
  onEndCallbacks = onEndCallbacks.filter(cb => cb !== callback);
}

export async function removeOnStartCallback(callback: () => Promise<void>) {
  onStartCallbacks = onStartCallbacks.filter(cb => cb !== callback);
}

async function triggerOnEndCallbacks() {
  isPlaying = false;
  for (const callback of onEndCallbacks) {
    callback();
  }
}

async function triggerOnStartCallbacks() {
  isPlaying = true;
  for (const callback of onStartCallbacks) {
    callback();
  }
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

setTimeout(() => {
  DiscordBot.onStreamIdle(async () => {
    await triggerOnEndCallbacks();
  });
}, 100);