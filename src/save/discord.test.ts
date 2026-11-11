import {expect, test} from 'bun:test';
import {REST} from 'discord.js';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {formatSaveProgress, formatSaveResult, uploadSavedVideo} from '../commands/saveUpload';
import {SaveError} from './errors';

test('shows the real byte limit and distinguishes unknown/estimated download sizes', () => {
  const unknown = formatSaveProgress({stage: 'download', downloaded: 10_000_000, total: null, inputLimit: 50_000_000});
  expect(unknown).toContain('rozmiar nieznany');
  expect(unknown).not.toContain('%');
  const estimated = formatSaveProgress({stage: 'download', downloaded: 10_000_000, total: 20_000_000,
    inputLimit: 50_000_000, approximate: true});
  expect(estimated).toContain('~');
  expect(estimated).toContain('50%');
  const result = formatSaveResult({path: '/unused', title: '@everyone *clip*', width: 320, height: 180,
    duration: 2, size: 1000, limit: 10_485_760, attempts: 0});
  expect(result).toContain('10485760');
  expect(result).toContain('1000');
});

test('an oversize failure includes measured bytes and the effective limit', () => {
  const error = new SaveError('validation', 'Oversized output', 20_000_001, 20_000_000);
  expect(error.userMessage).toContain('20000001');
  expect(error.userMessage).toContain('20000000');
});

test('an upload in progress is cancelled rather than retaining its file indefinitely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'save-aborted-upload-'));
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch() {
    started.resolve();
    await release.promise;
    return Response.json({});
  }});
  const rest = new REST({api: new URL('api', server.url).href, retries: 0, timeout: 2000});
  try {
    const path = join(dir, 'test.mp4');
    await writeFile(path, Buffer.alloc(1000));
    const controller = new AbortController();
    const result = uploadSavedVideo(rest, '123456789012345678', 'test-token',
      {path, title: 'clip', width: 320, height: 180, duration: 2, size: 1000, limit: 20_000_000, attempts: 0}, controller.signal)
      .catch((error: unknown) => error);
    await started.promise;
    controller.abort();
    expect(await result).toMatchObject({code: 'upload'});
  } finally {
    release.resolve();
    server.stop(true);
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
    await rm(dir, {recursive: true, force: true});
  }
});

test('uploads one verified attachment with mentions disabled and abort support', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'save-upload-test-'));
  let payload: unknown;
  let attachmentSize = 0;
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, async fetch(request) {
    const data = await request.formData();
    payload = JSON.parse(String(data.get('payload_json')));
    const attachment = data.get('files[0]');
    attachmentSize = attachment instanceof Blob ? attachment.size : 0;
    return Response.json({});
  }});
  const rest = new REST({api: new URL('api', server.url).href, retries: 0, timeout: 1000});
  try {
    const path = join(dir, 'test.mp4');
    await writeFile(path, Buffer.alloc(1000));
    const video = {path, title: 'clip', width: 320, height: 180, duration: 2, size: 1000, limit: 20_000_000, attempts: 0};
    await uploadSavedVideo(rest, '123456789012345678', 'test-token', video, AbortSignal.timeout(3000));
    expect(attachmentSize).toBe(1000);
    expect(payload).toMatchObject({allowed_mentions: {parse: []}, attachments: [{id: '0', filename: 'film.mp4'}]});
    const controller = new AbortController();
    controller.abort();
    await expect(uploadSavedVideo(rest, '123456789012345678', 'test-token', video, controller.signal)).rejects.toMatchObject({code: 'upload'});
    await expect(uploadSavedVideo(rest, '123456789012345678', 'test-token', {...video, limit: 1000}, AbortSignal.timeout(3000))).rejects.toThrow();
  } finally {
    server.stop(true);
    rest.clearHashSweeper();
    rest.clearHandlerSweeper();
    await rm(dir, {recursive: true, force: true});
  }
});
