import {readFile} from 'node:fs/promises';
import {isAbsolute, join} from 'node:path';

import {SaveError} from './errors';

export const MiB = 1_048_576;
export const PROCESSING_MS = 10 * 60_000;
export const AUXILIARY_BYTES = 32 * MiB;

export interface SaveConfig {
  tmpfsDir?: string;
  maxInputBytes: number;
  memoryReserveBytes: number;
}

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ?
      value as Record<string, unknown> : {};
}

export function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function parseSaveConfig(raw: unknown): SaveConfig {
  const root = object(raw);
  if (root.save !== undefined && (root.save === null || typeof root.save !== 'object' || Array.isArray(root.save))) {
    throw new SaveError('config');
  }
  const section = object(root.save);
  const maxInputBytes = section.maxInputBytes === undefined ? 256 * MiB : section.maxInputBytes;
  const memoryReserveBytes = section.memoryReserveBytes === undefined ? 512 * MiB : section.memoryReserveBytes;
  if (!positive(maxInputBytes) || !Number.isSafeInteger(maxInputBytes) ||
      !positive(memoryReserveBytes) || !Number.isSafeInteger(memoryReserveBytes) ||
      (section.tmpfsDir !== undefined && (typeof section.tmpfsDir !== 'string' || !isAbsolute(section.tmpfsDir)))) {
    throw new SaveError('config');
  }
  return {maxInputBytes, memoryReserveBytes, tmpfsDir: section.tmpfsDir as string|undefined};
}

export async function getSaveConfig(): Promise<SaveConfig> {
  let content: string;
  try {
    content = await readFile(join(import.meta.dir, '..', '..', 'config.json'), 'utf8');
  } catch (error) {
    if (object(error).code === 'ENOENT') return parseSaveConfig({});
    throw new SaveError('config');
  }
  try {
    const raw: unknown = JSON.parse(content);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new SaveError('config');
    return parseSaveConfig(raw);
  } catch {
    throw new SaveError('config');
  }
}

export function getOutputLimit(discordLimit: number): number {
  if (!positive(discordLimit) || !Number.isSafeInteger(discordLimit)) throw new SaveError('validation', 'Invalid Discord attachment limit');
  return Math.min(20_000_000, discordLimit);
}

export function isUploadable(size: number, limit: number): boolean {
  return Number.isSafeInteger(size) && size > 0 && size < limit;
}

export function sourceBudget(memory: number, free: number, limit: number, config: SaveConfig): number {
  const budget = Math.floor(Math.min(config.maxInputBytes,
      memory - config.memoryReserveBytes - 2 * limit - AUXILIARY_BYTES,
      free - 2 * limit - AUXILIARY_BYTES));
  if (!positive(budget)) throw new SaveError('memory');
  return budget;
}

export interface VideoFormat {
  id: string;
  video: boolean;
  audio: boolean;
  width: number;
  height: number;
  fps: number;
  vcodec: string;
  acodec: string;
  size: number|null;
  approximate: boolean;
}

export interface VideoMetadata {
  title: string;
  duration: number;
  formats: VideoFormat[];
  raw: Record<string, unknown>;
}

export interface Selection {
  tracks: VideoFormat[];
  estimatedBytes: number|null;
  approximate: boolean;
}

export function parseMetadata(value: unknown): VideoMetadata {
  const raw = object(value);
  if (raw._type === 'playlist' || raw._type === 'multi_video' || raw.is_live === true ||
      ['is_live', 'is_upcoming', 'post_live'].includes(String(raw.live_status)) || !positive(raw.duration)) {
    throw new SaveError('input');
  }
  const entries = Array.isArray(raw.formats) ? raw.formats : [raw];
  const formats: VideoFormat[] = [];
  for (const entry of entries) {
    const f = object(entry);
    if (f.has_drm || typeof f.format_id !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(f.format_id)) continue;
    const hls = f.protocol === 'm3u8' || f.protocol === 'm3u8_native';
    // Native fragment downloaders stage whole chunks before they reach stdout.
    // The accepted HLS variants use FFmpeg instead (see downloaderArgs).
    if (hls ? f.impersonate != null :
        (f.protocol !== undefined && f.protocol !== 'http' && f.protocol !== 'https') || Array.isArray(f.fragments)) continue;
    const vcodec = typeof f.vcodec === 'string' ? f.vcodec : '';
    const acodec = typeof f.acodec === 'string' ? f.acodec : '';
    const video = vcodec !== 'none' && (vcodec !== '' || positive(f.width));
    const audio = acodec !== '' && acodec !== 'none';
    let size: number|null = positive(f.filesize) ? f.filesize : positive(f.filesize_approx) ? f.filesize_approx : null;
    if (size === null && positive(f.tbr)) size = raw.duration * f.tbr * 1000 / 8;
    formats.push({id: f.format_id, video, audio,
      width: positive(f.width) ? f.width : 0, height: positive(f.height) ? f.height : 0,
      fps: positive(f.fps) ? f.fps : 0, vcodec, acodec, size,
      approximate: !positive(f.filesize)});
  }
  if (!formats.some(f => f.video)) throw new SaveError('format');
  return {title: typeof raw.title === 'string' ? raw.title.slice(0, 200) : 'Film', duration: raw.duration, formats, raw};
}

export function selectFormats(metadata: VideoMetadata, inputLimit: number): Selection {
  const shortSide = (f: VideoFormat) => Math.min(f.width, f.height);
  const videos = metadata.formats.filter(f => f.video && f.width > 0 && f.height > 0 && shortSide(f) <= 720)
      .sort((a, b) => shortSide(b) - shortSide(a) || Number(b.audio) - Number(a.audio) ||
          Math.min(b.fps, 30) - Math.min(a.fps, 30) || Number(b.vcodec.startsWith('avc')) - Number(a.vcodec.startsWith('avc')));
  const audios = metadata.formats.filter(f => f.audio && !f.video)
      .sort((a, b) => Number(b.acodec.startsWith('mp4a')) - Number(a.acodec.startsWith('mp4a')) || (a.size ?? Infinity) - (b.size ?? Infinity));
  const hasAudio = metadata.formats.some(f => f.audio);
  for (const video of videos) {
    const candidates = video.audio || !hasAudio ? [[video]] : audios.map(audio => [video, audio]);
    for (const tracks of candidates) {
      const estimatedBytes = tracks.every(f => f.size !== null) ? tracks.reduce((sum, f) => sum + (f.size ?? 0), 0) : null;
      // Even a partially known sum can prove that the combination is too big.
      const knownBytes = tracks.reduce((sum, f) => sum + (f.size ?? 0), 0);
      if (knownBytes * 1.25 > inputLimit) continue;
      return {tracks, estimatedBytes, approximate: tracks.some(f => f.approximate)};
    }
  }
  throw new SaveError('format');
}

export interface EncodingPlan {videoBitrate: number; shortSide: number;}

export function encodingPlan(duration: number, hasAudio: boolean, targetBytes: number): EncodingPlan {
  const videoBitrate = Math.floor(targetBytes * 8 / duration) - (hasAudio ? 96_000 : 0);
  if (!positive(duration) || !positive(targetBytes) || !Number.isFinite(videoBitrate) || videoBitrate < 150_000) {
    throw new SaveError('validation', 'Insufficient bitrate for full video');
  }
  return {videoBitrate, shortSide: videoBitrate >= 1_200_000 ? 720 : videoBitrate >= 600_000 ? 480 : 360};
}
