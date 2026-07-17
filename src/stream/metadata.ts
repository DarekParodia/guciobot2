import {$} from 'bun';

import {formatDuration} from '../utils';
import type {YtVideo} from './types';

interface FlatPlaylistEntry {
  id: string;
  title: string;
  duration: number;
}

// Resolves a URL to one or more YtVideo entries. `--flat-playlist` is a
// no-op for a plain video URL (yt-dlp only flattens actual playlists), so
// one call covers both a single video and a playlist — previously this was
// two separate yt-dlp invocations (an `isPlaylist` probe, then either
// `queryVideoInfo` or `getPlaylistVideos`).
//
// `limit` caps how many entries yt-dlp even fetches/parses for a playlist,
// instead of pulling a huge playlist fully into memory just to enqueue a
// fraction of it. Pass `config.maxQueueSize` from call sites.
export async function resolveVideos(url: string, limit: number): Promise<YtVideo[]> {
  const result =
      await $`yt-dlp --flat-playlist --playlist-end ${limit} -J ${url}`.json();

  if (result._type === 'playlist') {
    return (result.entries as FlatPlaylistEntry[]).map(entry => ({
      url: `https://www.youtube.com/watch?v=${entry.id}`,
      title: entry.title,
      duration: entry.duration,
      durationString: formatDuration(entry.duration),
    }));
  }

  return [{
    url: result.webpage_url,
    title: result.title,
    duration: result.duration,
    durationString: result.duration_string ?? formatDuration(result.duration),
  }];
}
