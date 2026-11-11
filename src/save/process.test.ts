import {expect, test} from 'bun:test';
import {readFile} from 'node:fs/promises';

import {SaveError} from './errors';
import {SaveJob} from './process';

test('checks stdout cap before handing an oversized chunk to the writer', async () => {
  const job = new SaveJob();
  let written = 0;
  try {
    await expect(job.run(process.execPath, ['-e', 'process.stdout.write(Buffer.alloc(2048))'], {
      maxBytes: 1024, onData: async chunk => { written += chunk.length; },
    })).rejects.toMatchObject({code: 'limit'});
    expect(written).toBeLessThanOrEqual(1024);
  } finally { await job.close(); }
});

test('nonzero exit and missing executable become bounded process errors', async () => {
  const job = new SaveJob();
  try {
    await expect(job.run(process.execPath, ['-e', 'process.exit(7)'], {errorCode: 'download'})).rejects.toMatchObject({code: 'download'});
    await expect(job.run('/this-command-does-not-exist', [])).rejects.toBeInstanceOf(SaveError);
  } finally { await job.close(); }
});

test('timeout kills the entire process group, including spawned children', async () => {
  const job = new SaveJob();
  let childPid = 0;
  try {
    await expect(job.run(process.execPath, ['-e',
      'const {spawn}=await import("node:child_process"); const p=spawn("sleep",["30"],{stdio:"ignore"}); console.log(p.pid); setInterval(()=>{},1000);',
    ], {timeoutMs: 250, onLine: line => { childPid = Number(line); }})).rejects.toMatchObject({code: 'timeout'});
    expect(childPid).toBeGreaterThan(0);
    let state = '';
    try { state = (await readFile(`/proc/${childPid}/stat`, 'utf8')).split(' ')[2] ?? ''; } catch {}
    expect(['', 'Z', 'X']).toContain(state);
  } finally { await job.close(); }
});

test('external abort and expired total budget stop work', async () => {
  const controller = new AbortController();
  const job = new SaveJob({signal: controller.signal});
  const result = job.run('sleep', ['30']);
  controller.abort(new SaveError('shutdown'));
  await expect(result).rejects.toMatchObject({code: 'shutdown'});
  await job.close();
  const expired = new SaveJob({deadline: performance.now() - 1});
  await expect(expired.run('sleep', ['30'])).rejects.toMatchObject({code: 'timeout'});
  await expired.close();
});
