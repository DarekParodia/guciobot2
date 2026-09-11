import {AudioPlayerStatus} from '@discordjs/voice';
import {Hono} from 'hono';
import type {Context} from 'hono';

import {DiscordBot} from '../bot';
import {config} from '../config';
import {createLogger} from '../logger';
import type {YtVideo} from '../stream';
import {queueManager, resolveVideos} from '../stream';
import {parseTimestampToSeconds} from '../utils';

const log = createLogger('api:music');

type PlayerStatus = 'idle'|'buffering'|'playing'|'paused';

interface VideoPayload {
  url: string;
  title: string;
  duration: number;
  durationString: string;
  startSeconds?: number;
}

// JSON-safe projection of a YtVideo — strips the onStart/onEnd callbacks,
// which aren't serializable and are none of an API client's business.
function videoPayload(video: YtVideo): VideoPayload {
  const payload: VideoPayload = {
    url: video.url,
    title: video.title,
    duration: video.duration,
    durationString: video.durationString,
  };
  if (video.startSeconds !== undefined) payload.startSeconds = video.startSeconds;
  return payload;
}

function playerStatus(): PlayerStatus {
  switch (DiscordBot.player.state.status) {
    case AudioPlayerStatus.Playing:
      return 'playing';
    case AudioPlayerStatus.Paused:
    case AudioPlayerStatus.AutoPaused:
      return 'paused';
    case AudioPlayerStatus.Buffering:
      return 'buffering';
    default:
      return 'idle';
  }
}

// Parses the request body as a JSON object; null for anything else
// (malformed JSON, arrays, scalars, empty body).
async function readJsonObject(c: Context): Promise<Record<string, unknown>|null> {
  try {
    const body: unknown = await c.req.json();
    return (body !== null && typeof body === 'object' && !Array.isArray(body)) ?
        body as Record<string, unknown> :
        null;
  } catch {
    return null;
  }
}

// Shared by /play and /playnext: resolves `url` to one or more videos
// (expanding playlists up to config.maxQueueSize) and applies the optional
// `start` timestamp to single-video adds — same semantics as
// resolveSongsToAdd in src/commands/utils.ts, minus the Discord parts.
async function resolveSongs(url: string, start: unknown): Promise<YtVideo[]> {
  const songs = await resolveVideos(url, config.maxQueueSize);

  if (songs.length === 1 && typeof start === 'string' && start.trim() !== '') {
    const parsed = parseTimestampToSeconds(start);
    if (!isNaN(parsed) && parsed > 0) songs[0]!.startSeconds = parsed;
  }

  return songs;
}

type AddMode = 'play'|'playnext';

// Shared handler for POST /play and POST /playnext. Joins a voice channel
// first when the bot isn't playing yet — the API has no invoking member, so
// the channel comes from the request body or the bot's last known one.
async function handleAdd(c: Context, mode: AddMode): Promise<Response> {
  const body = await readJsonObject(c);
  if (!body) return c.json({error: 'Nieprawidłowy JSON.'}, 400);

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return c.json({error: 'Pole "url" jest wymagane.'}, 400);

  let songs: YtVideo[];
  try {
    songs = await resolveSongs(url, body.start);
  } catch (error) {
    log.error('Failed to resolve URL with yt-dlp:', error);
    return c.json({error: 'Nie udało się rozpoznać linku (yt-dlp).'}, 400);
  }

  // Same rule as the /play slash command: only touch voice when nothing is
  // playing yet. joinChannel() re-joining an active connection is harmless.
  if (!queueManager.isPlaying()) {
    const requestedId =
        typeof body.voiceChannelId === 'string' ? body.voiceChannelId.trim() : '';
    const channel = requestedId ?
        await DiscordBot.fetchVoiceChannel(requestedId) :
        DiscordBot.voiceChannel;
    if (!channel) {
      return c.json(
          {error: 'Bot nie jest połączony z kanałem głosowym — podaj voiceChannelId.'},
          409);
    }

    try {
      await DiscordBot.joinChannel(channel);
    } catch (error) {
      log.error('Failed to join voice channel:', error);
      return c.json({error: 'Nie udało się połączyć z kanałem głosowym.'}, 502);
    }
  }

  // /playnext inserts at the head, so enqueue in reverse to keep the
  // playlist's original order at the front of the queue (same trick as
  // src/commands/playnext.ts); the response reports them in original order.
  const ordered = mode === 'playnext' ? [...songs].reverse() : songs;

  const added: VideoPayload[] = [];
  let skipped = 0;
  for (const song of ordered) {
    const ok = mode === 'playnext' ?
        await queueManager.enqueueNext(song) :
        await queueManager.enqueue(song);
    if (ok) added.push(videoPayload(song));
    else skipped++;
  }
  if (mode === 'playnext') added.reverse();

  return c.json({added, skipped, queueSize: queueManager.getQueueSize()}, 202);
}

export const musicApi = new Hono();

musicApi.get('/nowplaying', (c) => {
  const current = queueManager.getCurrentVideo();
  return c.json({
    status: playerStatus(),
    video: current ? videoPayload(current) : null,
  });
});

musicApi.get('/queue', (c) => c.json({
  size: queueManager.getQueueSize(),
  videos: queueManager.getQueue().map(videoPayload),
}));

musicApi.post('/play', (c) => handleAdd(c, 'play'));

musicApi.post('/playnext', (c) => handleAdd(c, 'playnext'));

musicApi.post('/skip', async (c) => {
  const skippedVideo = queueManager.getCurrentVideo();
  await queueManager.skip();
  const nowPlaying = queueManager.getCurrentVideo();
  return c.json({
    skipped: skippedVideo ? videoPayload(skippedVideo) : null,
    nowPlaying: nowPlaying ? videoPayload(nowPlaying) : null,
    status: playerStatus(),
  });
});

musicApi.post('/shuffle', (c) => {
  queueManager.shuffle();
  return c.json({shuffled: true, size: queueManager.getQueueSize()});
});

musicApi.post('/clear', (c) => {
  const removed = queueManager.getQueueSize();
  queueManager.clear();
  return c.json({cleared: true, removed});
});

musicApi.post('/pause', (c) => {
  if (DiscordBot.player.state.status !== AudioPlayerStatus.Playing) {
    return c.json({error: 'Nic nie jest odtwarzane.'}, 409);
  }
  DiscordBot.player.pause();
  return c.json({status: 'paused'});
});

musicApi.post('/resume', (c) => {
  if (DiscordBot.player.state.status !== AudioPlayerStatus.Paused) {
    return c.json({error: 'Odtwarzanie nie jest wstrzymane.'}, 409);
  }
  DiscordBot.player.unpause();
  return c.json({status: 'playing'});
});
