import {createLogger} from '../logger';
import type {YtVideo} from './types';
import {YoutubeStream} from './youtubeStream';

const log = createLogger('queue');

// Owns the playback queue and the currently-playing stream. This used to be
// a bag of module-level `var`s shared implicitly across the file — now it's
// a single object other modules interact with through explicit methods.
class QueueManager {
  private queue: YtVideo[] = [];
  private current: YoutubeStream|null = null;
  private playing = false;

  async enqueue(video: YtVideo) {
    this.queue.push(video);
    log.info(`Queued: ${video.title}`);
    if (!this.playing) await this.playNext();
  }

  async enqueueNext(video: YtVideo) {
    this.queue.unshift(video);
    log.info(`Queued next: ${video.title}`);
    if (!this.playing) await this.playNext();
  }

  clear() {
    this.queue = [];
  }

  async skip() {
    await this.playNext();
  }

  shuffle() {
    for (let i = this.queue.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.queue[i], this.queue[j]] = [this.queue[j]!, this.queue[i]!];
    }
  }

  getQueue(): readonly YtVideo[] {
    return this.queue;
  }

  getQueueSize(): number {
    return this.queue.length;
  }

  getCurrentVideo(): YtVideo|null {
    return this.current?.video ?? null;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  // Called by the bot's AudioPlayer 'Idle' event handler once playback of
  // the current stream has actually finished.
  async handleStreamEnd() {
    const finished = this.current;
    this.playing = false;
    this.current = null;
    if (finished) await finished.video.onEnd?.();
    await this.playNext();
  }

  // Stops playback and drops the queue — used on process shutdown so
  // spawned yt-dlp/ffmpeg processes don't linger.
  shutdown() {
    this.queue = [];
    this.current?.stop();
    this.current = null;
    this.playing = false;
  }

  private async playNext() {
    const next = this.queue.shift();
    if (!next) {
      log.info('Queue empty.');
      return;
    }
    await this.play(next);
  }

  private async play(video: YtVideo) {
    this.current?.stop();

    const stream = new YoutubeStream(video);
    this.current = stream;
    this.playing = true;
    stream.start();
    await video.onStart?.();
  }
}

export const queueManager = new QueueManager();
