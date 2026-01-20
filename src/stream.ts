import {createAudioResource, StreamType} from '@discordjs/voice';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';
import {spawn} from 'node:child_process';
import {Readable} from 'node:stream';

import {DiscordBot} from './Discord';

var currentStream: YoutubeStream|null = null;

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

    this.process = spawn('yt-dlp', [
      '-f',
      'bestaudio/best',
      '--no-playlist',
      '--no-warnings',
      '--geo-bypass',
      '-o',
      '-',
      this.url,
    ]);

    // CORRECTION HERE:
    this.ffmpegProcess = spawn('ffmpeg', [
      '-i', 'pipe:0',          // Input from yt-dlp
      '-ac', '2',              // Force 2 channels (Stereo)
      '-ar', '48000',          // Force 48kHz sample rate
      '-f', 's16le',           // PCM 16-bit signed little-endian
      '-filter:a', 'volume=0.5',
      '-loglevel', 'warning',  // Reduce log spam
      'pipe:1'                 // Output to stdout
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
  }

  override _read() {
    // No-op — data is pushed from the child process
  }

  override _destroy(err: Error|null, callback: (error?: Error|null) => void) {
    if (this.process) {
      this.process.kill('SIGKILL');
    }
    if (this.ffmpegProcess) {
      this.ffmpegProcess.kill('SIGKILL');
    }
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
      inputType: StreamType.Raw,  // Oznaczamy że to raw PCM data
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

export async function playYoutubeStream(url: string) {
  if (currentStream) {
    await currentStream.stop();
  }
  console.log(`Starting YouTube stream for: ${url}`);
  currentStream = new YoutubeStream(url);
  await currentStream.start();
  console.log('YouTube stream started');
}

export async function playFromFile(filePath: string) {
  if (currentStream) {
    await currentStream.stop();
  }
  console.log(`Playing from file: ${filePath}`);
  const resource = createAudioResource(filePath);
  console.log('Audio resource created');
  DiscordBot.player.play(resource);
  console.log('Player started playing');
}