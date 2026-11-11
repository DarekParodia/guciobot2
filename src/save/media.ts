import {open, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {SaveError} from './errors';
import {encodingPlan, isUploadable, object, parseMetadata, positive, selectFormats} from './policy';
import type {Selection} from './policy';
import {SaveJob} from './process';
import {checkResources} from './resources';
import type {Workspace} from './resources';

export interface SaveProgress {
  stage: 'inspect'|'selected'|'download'|'probe'|'remux'|'encode'|'retry'|'validate'|'upload';
  title?: string;
  limit?: number;
  inputLimit?: number;
  downloaded?: number;
  total?: number|null;
  approximate?: boolean;
  speed?: number;
  eta?: number;
  pass?: number;
  attempt?: number;
  fraction?: number;
  shortSide?: number;
  size?: number;
}

export type Progress = (progress: SaveProgress) => void;

export interface SavedVideo {
  path: string;
  title: string;
  width: number;
  height: number;
  duration: number;
  size: number;
  limit: number;
  attempts: number;
}

export interface MediaInfo {
  video: boolean;
  audio: boolean;
  width: number;
  height: number;
  duration: number;
  videoDuration: number|null;
  audioDuration: number|null;
  h264: boolean;
  aac: boolean;
  mp4: boolean;
}

function streamDuration(stream: Record<string, unknown>|undefined): number|null {
  const duration = Number(stream?.duration);
  if (positive(duration)) return duration;
  const tag = object(stream?.tags).DURATION;
  if (typeof tag !== 'string' || !/^\d+:\d{2}:\d{2}(\.\d+)?$/.test(tag)) return null;
  const [hours = 0, minutes = 0, seconds = 0] = tag.split(':').map(Number);
  const tagged = hours * 3600 + minutes * 60 + seconds;
  return positive(tagged) ? tagged : null;
}

export async function probeMedia(job: SaveJob, path: string): Promise<MediaInfo> {
  const output = await job.run('ffprobe', ['-v', 'error', '-show_entries',
    'format=duration,format_name:format_tags=major_brand:stream=codec_type,codec_name,pix_fmt,width,height,duration:stream_tags=DURATION:stream_side_data=rotation',
    '-of', 'json', path], {errorCode: 'validation', timeoutMs: 30_000});
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(output.toString())); } catch { throw new SaveError('validation'); }
  const streams = Array.isArray(data.streams) ? data.streams.map(object) : [];
  const video = streams.find(s => s.codec_type === 'video');
  const audio = streams.find(s => s.codec_type === 'audio');
  const format = object(data.format);
  const duration = Number(format.duration);
  if (!positive(duration)) throw new SaveError('validation');
  const sideData = Array.isArray(video?.side_data_list) ? video.side_data_list.map(object) : [];
  const rotated = Math.abs(Number(sideData.find(s => s.rotation !== undefined)?.rotation ?? 0)) % 180 === 90;
  const width = Number(video?.width ?? 0);
  const height = Number(video?.height ?? 0);
  return {video: !!video, audio: !!audio, width: rotated ? height : width, height: rotated ? width : height,
    duration, videoDuration: streamDuration(video), audioDuration: streamDuration(audio),
    h264: video?.codec_name === 'h264' && video.pix_fmt === 'yuv420p',
    aac: !audio || audio.codec_name === 'aac',
    mp4: String(format.format_name).split(',').includes('mp4') &&
        typeof object(format.tags).major_brand === 'string' && !String(object(format.tags).major_brand).startsWith('qt'),
  };
}

function downloaderArgs(workDir: string): string[] {
  return ['--ignore-config', '--no-cache-dir', '--no-playlist', '--no-warnings', '--no-colors',
    '--js-runtimes', 'bun', '--socket-timeout', '15', '--retries', '2', '--fragment-retries', '2',
    '--abort-on-unavailable-fragments', '--fixup', 'never',
    '--downloader', 'm3u8:ffmpeg',
    '--paths', `home:${workDir}`, '--paths', `temp:${workDir}`];
}

export async function downloadTracks(
    job: SaveJob, selection: Selection, infoPath: string, workDir: string,
    inputLimit: number, progress: Progress): Promise<string[]> {
  let downloaded = 0;
  let speed = 0;
  let eta = 0;
  const paths: string[] = [];
  for (const [index, track] of selection.tracks.entries()) {
    const path = join(workDir, `track-${index}`);
    const file = await open(path, 'wx', 0o600);
    const previous = downloaded;
    let trackTotal = track.size;
    let trackApproximate = track.approximate;
    try {
      await job.run('yt-dlp', [...downloaderArgs(workDir), '--load-info-json', infoPath,
        '-f', `b*[format_id=${track.id}]`, '-o', '-', '--no-part', '--no-simulate', '--max-filesize', String(inputLimit),
        '--progress', '--newline', '--progress-delta', '0.5', '--progress-template',
        'download:SAVE:%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
      ], {cwd: workDir, errorCode: 'download', maxBytes: inputLimit - previous, linesFrom: 'stderr',
        onLine: line => {
          if (!line.startsWith('SAVE:')) return;
          const values = line.slice(5).split('|').map(Number);
          if (positive(values[1]) || positive(values[2])) {
            trackTotal = positive(values[1]) ? values[1] : values[2]!;
            trackApproximate = !positive(values[1]);
          }
          speed = positive(values[3]) ? values[3] : 0;
          eta = positive(values[4]) ? values[4] : 0;
        },
        onData: async chunk => {
          // SaveJob enforces the remaining cap before this writer sees a chunk.
          let offset = 0;
          while (offset < chunk.length) {
            const written = await file.write(chunk, offset, chunk.length - offset);
            if (written.bytesWritten <= 0) throw new SaveError('memory');
            offset += written.bytesWritten;
          }
          downloaded += chunk.length;
          const rest = selection.tracks.slice(index + 1);
          const total = trackTotal !== null && rest.every(f => f.size !== null) ?
              previous + trackTotal + rest.reduce((sum, f) => sum + (f.size ?? 0), 0) : null;
          progress({stage: 'download', downloaded, total: total !== null && total >= downloaded ? total : null,
            approximate: trackApproximate || rest.some(f => f.approximate), inputLimit, speed,
            eta: selection.tracks.length === 1 ? eta : undefined});
        }});
      if (downloaded === previous) throw new SaveError('download', 'Downloader returned an empty track');
    } catch (error) {
      if (error instanceof SaveError && error.code === 'limit') {
        throw new SaveError('limit', 'Aggregate source cap exceeded', previous + (error.size ?? 0), inputLimit);
      }
      throw error;
    } finally { await file.close(); }
    paths.push(path);
  }
  return paths;
}

function closeDuration(actual: number|null, expected: number|null): boolean {
  return expected === null || (positive(actual) && Math.abs(actual - expected) <= Math.max(1, expected * 0.01));
}

export async function convertVideo(
    job: SaveJob, paths: string[], title: string, limit: number, workDir: string,
    progress: Progress): Promise<SavedVideo> {
  progress({stage: 'probe'});
  const inputs = await Promise.all(paths.map(path => probeMedia(job, path)));
  const videoIndex = inputs.findIndex(media => media.video);
  const audioIndex = inputs.findIndex(media => media.audio);
  const video = inputs[videoIndex];
  if (!video || video.width < 2 || video.height < 2) throw new SaveError('validation');
  const hasAudio = audioIndex >= 0;
  const audio = inputs[audioIndex];
  const timeline = Math.max(...inputs.map(input => input.duration));
  const videoDuration = video.videoDuration ?? video.duration;
  const makeResult = (path: string, media: MediaInfo, size: number, attempts: number): SavedVideo => {
    if (!media.video || !media.h264 || !media.aac || !media.mp4 || !isUploadable(size, limit) ||
        !closeDuration(media.duration, timeline) || !closeDuration(media.videoDuration, video.videoDuration) ||
        (hasAudio && (!media.audio || !closeDuration(media.audioDuration, audio?.audioDuration ?? null)))) {
      throw new SaveError('validation', 'Invalid final media or size', size, limit);
    }
    return {path, title, width: media.width, height: media.height, duration: media.duration, size, limit, attempts};
  };
  const source = paths[videoIndex]!;
  const sourceSize = (await stat(source)).size;
  if (paths.length === 1 && video.h264 && video.aac && video.mp4 && isUploadable(sourceSize, limit)) {
    return makeResult(source, video, sourceSize, 0);
  }
  const outputPath = join(workDir, 'output.mp4');
  const inputArgs = paths.flatMap(path => ['-threads', '2', '-i', path]);
  const maps = ['-map', `${videoIndex}:v:0`, ...(hasAudio ? ['-map', `${audioIndex}:a:0`] : [])];
  const common = ['-v', 'error', '-nostdin', '-nostats', '-y', '-filter_threads', '2', '-filter_complex_threads', '2'];
  const totalSize = (await Promise.all(paths.map(path => stat(path)))).reduce((sum, s) => sum + s.size, 0);
  if (video.h264 && (!hasAudio || audio?.aac) && totalSize < limit) {
    progress({stage: 'remux'});
    await job.run('ffmpeg', [...common, ...inputArgs, ...maps, '-c', 'copy', '-map_metadata', '-1',
      '-map_chapters', '-1', '-movflags', '+faststart', outputPath], {errorCode: 'encode'});
    const size = (await stat(outputPath)).size;
    if (isUploadable(size, limit)) return makeResult(outputPath, await probeMedia(job, outputPath), size, 0);
    await rm(outputPath, {force: true});
  }

  let target = Math.floor(limit * 0.95);
  let lastSize = 0;
  for (let attempt = 1; attempt <= 2; attempt++) {
    job.check();
    const plan = encodingPlan(timeline, hasAudio, target);
    const factor = `min(1,${plan.shortSide}/min(iw,ih))`;
    const filter = `scale=w='max(2,trunc(iw*${factor}/2)*2)':h='max(2,trunc(ih*${factor}/2)*2)':flags=lanczos`;
    const settings = ['-vf', filter, '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-pix_fmt', 'yuv420p',
      '-b:v', String(plan.videoBitrate), '-fpsmax', '30', '-passlogfile', join(workDir, 'pass'),
      '-map_metadata', '-1', '-map_chapters', '-1'];
    for (const pass of [1, 2]) {
      let fraction = 0;
      const emit = () => progress({stage: 'encode', attempt, pass, fraction, shortSide: plan.shortSide});
      emit();
      await job.run('ffmpeg', [...common, ...inputArgs,
        ...(pass === 1 ? ['-map', `${videoIndex}:v:0`] : maps), ...settings,
        '-pass', String(pass), '-progress', 'pipe:1',
        ...(pass === 1 ? ['-an', '-f', 'null', '/dev/null'] :
            [...(hasAudio ? ['-c:a', 'aac', '-b:a', '96k', '-ac', '2'] : ['-an']),
              '-movflags', '+faststart', outputPath]),
      ], {errorCode: 'encode', onLine: line => {
        if (line.startsWith('out_time_us=')) {
          const time = Number(line.slice(12));
          if (Number.isFinite(time)) fraction = Math.max(0, Math.min(1, time / 1e6 / (pass === 1 ? videoDuration : timeline)));
        }
        if (line.startsWith('progress=')) emit();
      }});
    }
    progress({stage: 'validate'});
    const size = (await stat(outputPath)).size;
    lastSize = size;
    if (isUploadable(size, limit)) return makeResult(outputPath, await probeMedia(job, outputPath), size, attempt);
    await rm(outputPath, {force: true});
    if (attempt === 1 && size > 0) {
      progress({stage: 'retry', attempt: 2, size, limit});
      target = Math.floor(target * Math.min(0.9, (limit - 1) / size * 0.9));
    }
  }
  throw new SaveError('validation', 'Both encoding attempts exceeded the limit', lastSize, limit);
}

export async function prepareVideo(
    job: SaveJob, url: string, limit: number, workspace: Workspace,
    progress: Progress): Promise<SavedVideo> {
  progress({stage: 'inspect', limit, inputLimit: workspace.inputLimit});
  const output = await job.run('yt-dlp', [...downloaderArgs(workspace.path),
    '--flat-playlist', '--playlist-end', '1', '--dump-single-json', '--skip-download', '--', url],
  {cwd: workspace.path, errorCode: 'download', timeoutMs: 45_000});
  let raw: unknown;
  try { raw = JSON.parse(output.toString()); } catch { throw new SaveError('download'); }
  const metadata = parseMetadata(raw);
  const selection = selectFormats(metadata, workspace.inputLimit);
  progress({stage: 'selected', title: metadata.title, limit, inputLimit: workspace.inputLimit,
    total: selection.estimatedBytes, approximate: selection.approximate});
  const infoPath = join(workspace.path, 'info.json');
  // yt-dlp otherwise re-extracts webpage_url on a failed replay and can
  // append bytes from a second attempt to the same stdout stream.
  const replay = {...metadata.raw};
  delete replay.webpage_url;
  await writeFile(infoPath, JSON.stringify(replay), {mode: 0o600});
  const paths = await downloadTracks(job, selection, infoPath, workspace.path, workspace.inputLimit, progress);
  await checkResources(workspace);
  const result = await convertVideo(job, paths, metadata.title, limit, workspace.path, progress);
  if (selection.tracks.some(track => track.audio) && !(await probeMedia(job, result.path)).audio) throw new SaveError('validation');
  return result;
}
