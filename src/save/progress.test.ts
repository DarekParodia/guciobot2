import {expect, test} from 'bun:test';

import {createProgressReporter} from './progress';

test('serializes edits and drops stale updates before final delivery', async () => {
  const firstStarted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const messages: string[] = [];
  const reporter = createProgressReporter(async message => {
    messages.push(message);
    firstStarted.resolve();
    await release.promise;
  }, 1);
  reporter.update('first');
  await firstStarted.promise;
  reporter.update('stale');
  const closing = reporter.close();
  release.resolve();
  await closing;
  reporter.update('after close');
  messages.push('final');
  await Bun.sleep(5);
  expect(messages).toEqual(['first', 'final']);
});

test('coalesces rapid updates to the latest message', async () => {
  const messages: string[] = [];
  const received = Promise.withResolvers<void>();
  const reporter = createProgressReporter(async message => {
    messages.push(message);
    received.resolve();
  }, 1);
  reporter.update('old');
  reporter.update('new');
  await received.promise;
  await reporter.close();
  expect(messages).toEqual(['new']);
});
