import {escapeMarkdown, REST, Routes} from 'discord.js';
import {readFile, stat} from 'node:fs/promises';

import {SaveError} from '../save/errors';
import type {SaveProgress, SavedVideo} from '../save/media';
import {isUploadable} from '../save/policy';
import {formatDuration} from '../utils';

export function formatMb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2).replace('.', ',')} MB`;
}

export function formatSaveProgress(p: SaveProgress): string {
  switch (p.stage) {
    case 'inspect': return 'Sprawdzam film i dostępny RAM…';
    case 'selected': return `Sprawdzono film. Rozmiar źródła: ${p.total == null ? 'nieznany' : `${p.approximate ? '~' : ''}${formatMb(p.total)}`} · limit pobierania: ${formatMb(p.inputLimit ?? 0)}.`;
    case 'download': {
      const bytes = p.downloaded ?? 0;
      const total = p.total;
      const amount = total ? `${p.approximate ? '~' : ''}${Math.min(99, Math.floor(bytes / total * 100))}% · ${formatMb(bytes)} / ${p.approximate ? '~' : ''}${formatMb(total)}` : `${formatMb(bytes)} · rozmiar nieznany`;
      return `Pobieram: ${amount} · limit pobierania ${formatMb(p.inputLimit ?? 0)}${
          p.speed ? ` · ${formatMb(p.speed)}/s` : ''}${p.eta ? ` · pozostało ~${Math.ceil(p.eta)} s` : ''}`;
    }
    case 'probe': return 'Sprawdzam pobrane ścieżki obrazu i dźwięku…';
    case 'remux': return 'Przygotowuję MP4 bez ponownego kodowania…';
    case 'encode': return `${p.pass === 1 ? 'Analizuję obraz' : 'Koduję'}: ${Math.floor((p.fraction ?? 0) * 100)}% · przebieg ${p.pass}/2 · próba ${p.attempt}/2 · do ${p.shortSide}p`;
    case 'retry': return `Plik ma ${formatMb(p.size ?? 0)} (${p.size} bajtów), limit to <${p.limit} bajtów. Ponawiam kodowanie · próba 2/2…`;
    case 'validate': return 'Sprawdzam rozmiar i kompletność filmu…';
    case 'upload': return `Wysyłam: ${formatMb(p.size ?? 0)} / limit ${formatMb(p.limit ?? 0)} (<${p.limit} bajtów)…`;
  }
}

export function formatSaveResult(video: SavedVideo): string {
  return `Gotowe! **${escapeMarkdown(video.title.replace(/[\r\n]/g, ' '))}**\n${
      formatDuration(video.duration)} · ${video.width}×${video.height} · ${formatMb(video.size)}\nRozmiar: ${video.size} bajtów · limit: <${video.limit} bajtów.`;
}

export async function editSaveMessage(
    rest: REST, applicationId: string, token: string, content: string,
    signal = AbortSignal.timeout(10_000)): Promise<void> {
  await rest.patch(Routes.webhookMessage(applicationId, token, '@original'), {
    auth: false, signal, body: {content, allowed_mentions: {parse: []}},
  });
}

export async function uploadSavedVideo(
    rest: REST, applicationId: string, token: string, video: SavedVideo,
    signal: AbortSignal): Promise<void> {
  // Recheck after encoding and before loading into REST's multipart buffer.
  const actual = (await stat(video.path)).size;
  if (!isUploadable(actual, video.limit) || actual !== video.size) throw new SaveError('validation');
  try {
    signal.throwIfAborted();
    const data = await readFile(video.path, {signal});
    signal.throwIfAborted();
    await rest.patch(Routes.webhookMessage(applicationId, token, '@original'), {
      auth: false, signal,
      body: {content: formatSaveResult(video), allowed_mentions: {parse: []},
        attachments: [{id: '0', filename: 'film.mp4'}]},
      files: [{data, name: 'film.mp4', key: 'files[0]', contentType: 'video/mp4'}],
    });
  } catch { throw new SaveError('upload'); }
}
