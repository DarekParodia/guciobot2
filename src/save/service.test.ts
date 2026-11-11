import {expect, test} from 'bun:test';
import {stat} from 'node:fs/promises';
import {join} from 'node:path';

import {SaveService} from './service';
import type {SavedVideo} from './media';

test('keeps the slot and tmpfs alive through delivery, then cleans up after failure', async () => {
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let workPath = '';
  const service = new SaveService(async (_job, _url, limit, workspace) => {
    workPath = workspace.path;
    return {path: join(workPath, 'result.mp4'), title: 'clip', width: 320, height: 180,
      duration: 2, size: 1000, limit, attempts: 0} satisfies SavedVideo;
  });
  const first = service.save('https://example.com/clip', 20_000_000, () => {}, async () => {
    started.resolve();
    await release.promise;
    throw new Error('failed delivery');
  });
  // Attach the rejection handler before the asynchronous callback can reject.
  const failure = first.catch((error: unknown) => error);
  await started.promise;
  expect((await stat(workPath)).isDirectory()).toBe(true);
  await expect(service.save('https://example.com/clip', 20_000_000, () => {}, async () => {})).rejects.toMatchObject({code: 'busy'});
  release.resolve();
  expect(await failure).toBeInstanceOf(Error);
  expect((await failure as Error).message).toBe('failed delivery');
  await expect(stat(workPath)).rejects.toThrow();
  await service.save('https://example.com/clip', 20_000_000, () => {}, async () => {});
});

test('shutdown aborts a running subprocess and waits for workspace cleanup', async () => {
  const started = Promise.withResolvers<void>();
  let workPath = '';
  const service = new SaveService(async (job, _url, _limit, workspace) => {
    workPath = workspace.path;
    started.resolve();
    await job.run('sleep', ['30']);
    throw new Error('unreachable');
  });
  const saving = service.save('https://example.com/clip', 20_000_000, () => {}, async () => {});
  const failure = saving.catch((error: unknown) => error);
  await started.promise;
  await service.shutdown();
  expect(await failure).toMatchObject({code: 'shutdown'});
  await expect(stat(workPath)).rejects.toThrow();
});
