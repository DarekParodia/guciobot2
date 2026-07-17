import {$} from 'bun';
import {spawn} from 'node:child_process';

import {createLogger} from '../logger';
import {formatDuration} from '../utils';
import type {YtVideo} from './types';

const log = createLogger('ytdlp');

export async function queryVideoInfo(url: string): Promise<YtVideo> {
  return new Promise<YtVideo>((resolve, reject) => {
    const ytDlpProcess = spawn('yt-dlp', [
      '--no-playlist',
      '--no-warnings',
      '--geo-bypass',
      '--js-runtimes',
      'bun',
      '-j',  // Output video info as JSON
      url,
    ]);

    let output = '';
    ytDlpProcess.stdout.on('data', (data) => {
      output += data.toString();
    });

    ytDlpProcess.stderr.on('data', (data) => {
      log.error(`yt-dlp error: ${data}`);
    });

    ytDlpProcess.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp exited with code ${code}`));
        return;
      }
      try {
        const info = JSON.parse(output);
        resolve({
          url: info.webpage_url,
          title: info.title,
          duration: info.duration,
          durationString: info.duration_string ?? formatDuration(info.duration),
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

export async function isPlaylist(url: string): Promise<boolean> {
  const result = await $`yt-dlp --flat-playlist -J ${url}`.json();
  return result._type === 'playlist';
}

export async function getPlaylistVideos(url: string): Promise<YtVideo[]> {
  const result = await $`yt-dlp --flat-playlist -J ${url}`.json();
  if (result._type !== 'playlist') {
    throw new Error('URL is not a playlist');
  }

  return (result.entries as Array<{id: string; title: string; duration: number}>)
      .map(entry => ({
             url: `https://www.youtube.com/watch?v=${entry.id}`,
             title: entry.title,
             duration: entry.duration,
             durationString: formatDuration(entry.duration),
           }));
}
