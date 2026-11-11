import {afterAll, beforeAll, expect, test} from 'bun:test';
import {execFile} from 'node:child_process';
import {appendFile, mkdtemp, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join} from 'node:path';
import {promisify} from 'node:util';

import {convertVideo, downloadTracks, probeMedia} from './media';
import {parseMetadata, selectFormats} from './policy';
import {SaveJob} from './process';

const exec = promisify(execFile);
let dir = '';
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'save-media-test-')); });
afterAll(async () => { await rm(dir, {recursive: true, force: true}); });

async function fixture(name: string, options: {audio?: boolean; portrait?: boolean; huge?: boolean; mov?: boolean} = {}): Promise<string> {
  const path = join(dir, name);
  await exec('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-f', 'lavfi', '-i',
    `testsrc2=size=${options.portrait ? '180x320' : '640x360'}:rate=24`,
    ...(options.audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'] : []),
    '-t', '2', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p',
    ...(options.huge ? ['-crf', '0'] : ['-crf', '25']),
    ...(options.audio ? ['-c:a', 'aac'] : []), path]);
  return path;
}

test('reuses a compatible seek-requiring MP4 without encoding', async () => {
  const input = await fixture('reuse.mp4', {audio: true});
  const job = new SaveJob();
  try {
    const result = await convertVideo(job, [input], 'clip', 20_000_000, dir, () => {});
    expect(result.path).toBe(input);
    expect(result.attempts).toBe(0);
    expect(result.duration).toBeCloseTo(2, 0);
    expect(result.width).toBe(640);
  } finally { await job.close(); }
});

test('remuxes compatible MOV to MP4 without a lossy pass', async () => {
  const input = await fixture('source.mov', {audio: true});
  const job = new SaveJob();
  try {
    const result = await convertVideo(job, [input], 'clip', 20_000_000, dir, () => {});
    expect(result.path).not.toBe(input);
    expect(result.attempts).toBe(0);
    expect(result.size).toBeLessThan(20_000_000);
  } finally { await job.close(); }
});

test('preserves Matroska audio that ends before the video', async () => {
  const input = join(dir, 'unequal-streams.mkv');
  await exec('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-threads', '2',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
  const job = new SaveJob();
  try {
    const result = await convertVideo(job, [input], 'clip', 20_000_000, dir, () => {});
    const media = await probeMedia(job, result.path);
    expect(media.duration).toBeCloseTo(5, 0);
    expect(media.audioDuration).toBeCloseTo(2, 0);
  } finally { await job.close(); }
});

test('two-pass encoding preserves video and audio while fitting a smaller byte limit', async () => {
  const input = await fixture('large.mp4', {audio: true, huge: true});
  expect((await stat(input)).size).toBeGreaterThan(150_000);
  const job = new SaveJob();
  const passes: number[] = [];
  try {
    const result = await convertVideo(job, [input], 'clip', 150_000, dir, progress => {
      if (progress.pass) passes.push(progress.pass);
    });
    const media = await probeMedia(job, result.path);
    expect(result.size).toBeLessThan(150_000);
    expect(result.size).toBeGreaterThan(0);
    expect(media.audio).toBe(true);
    expect(result.duration).toBeCloseTo(2, 0);
    expect(passes).toContain(1);
    expect(passes).toContain(2);
  } finally { await job.close(); }
}, 20_000);

test('silent portrait and rotated video retain display orientation', async () => {
  const portrait = await fixture('portrait.mp4', {portrait: true});
  const original = await fixture('before-rotation.mp4');
  const rotated = join(dir, 'rotated.mp4');
  await exec('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', original, '-c', 'copy', rotated]);
  const job = new SaveJob();
  try {
    const p = await convertVideo(job, [portrait], 'portrait', 20_000_000, dir, () => {});
    expect(p.width).toBe(180);
    expect(p.height).toBe(320);
    expect((await probeMedia(job, p.path)).audio).toBe(false);
    const r = await convertVideo(job, [rotated], 'rotated', 20_000_000, dir, () => {});
    expect(r.width).toBe(360);
    expect(r.height).toBe(640);
  } finally { await job.close(); }
});

test('measured overshoot triggers one smaller full retry', async () => {
  const input = await fixture('overshoot-source.mp4', {huge: true});
  let encodes = 0;
  class OvershootJob extends SaveJob {
    override async run(command: string, args: string[], options?: Parameters<SaveJob['run']>[2]): Promise<Buffer> {
      const result = await super.run(command, args, options);
      if (command === 'ffmpeg' && args.includes('-pass') && args[args.indexOf('-pass') + 1] === '2') {
        encodes++;
        if (encodes === 1) await appendFile(args[args.length - 1]!, Buffer.alloc(160_000));
      }
      return result;
    }
  }
  const job = new OvershootJob();
  try {
    const result = await convertVideo(job, [input], 'retry', 200_000, dir, () => {});
    expect(result.attempts).toBe(2);
    expect(encodes).toBe(2);
    expect(result.size).toBeLessThan(200_000);
  } finally { await job.close(); }
}, 20_000);

test('compression preserves rotation and refuses to return a truncated encode', async () => {
  const original = await fixture('rotated-large-source.mp4', {huge: true});
  const rotated = join(dir, 'rotated-large.mp4');
  await exec('ffmpeg', ['-v', 'error', '-y', '-display_rotation', '90', '-i', original, '-c', 'copy', rotated]);
  const job = new SaveJob();
  try {
    const result = await convertVideo(job, [rotated], 'rotated', 150_000, dir, () => {});
    expect(result.height).toBeGreaterThan(result.width);
    expect(result.size).toBeLessThan(150_000);
  } finally { await job.close(); }
  class TruncatingJob extends SaveJob {
    override run(command: string, args: string[], options?: Parameters<SaveJob['run']>[2]): Promise<Buffer> {
      if (command === 'ffmpeg' && args.includes('-pass') && args[args.indexOf('-pass') + 1] === '2') {
        args = ['-t', '0.2', ...args];
      }
      return super.run(command, args, options);
    }
  }
  const truncated = new TruncatingJob();
  try {
    await expect(convertVideo(truncated, [original], 'truncated', 150_000, dir, () => {})).rejects.toMatchObject({code: 'validation'});
  } finally { await truncated.close(); }
}, 20_000);

test('yt-dlp locks a literal mp4 format ID and enforces aggregate actual bytes', async () => {
  const bytes = Buffer.alloc(4096, 42);
  const requested: string[] = [];
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: request => {
    requested.push(new URL(request.url).pathname);
    return new Response(bytes);
  }});
  const meta = parseMetadata({id: 'clip', title: 'clip', duration: 2, extractor: 'generic', extractor_key: 'Generic',
    webpage_url: server.url.href, formats: [
      {format_id: 'mp4', url: new URL('video.mp4', server.url).href, ext: 'mp4', width: 320, height: 180,
        vcodec: 'avc1', acodec: 'none', filesize: 1},
      {format_id: 'high', url: new URL('wrong.mp4', server.url).href, ext: 'mp4', width: 1920, height: 1080,
        vcodec: 'avc1', acodec: 'none', filesize: 1},
      {format_id: 'a', url: new URL('audio.m4a', server.url).href, ext: 'm4a', vcodec: 'none', acodec: 'mp4a', filesize: 1},
    ]});
  const infoPath = join(dir, 'download-info.json');
  await writeFile(infoPath, JSON.stringify(meta.raw));
  const job = new SaveJob();
  try {
    await expect(downloadTracks(job, selectFormats(meta, 6144), infoPath, dir, 6144, () => {})).rejects.toMatchObject({code: 'limit'});
    const first = await readFile(join(dir, 'track-0'));
    expect(first.length).toBe(4096);
    expect(requested).toContain('/video.mp4');
    expect(requested).not.toContain('/wrong.mp4');
    expect((await stat(join(dir, 'track-1'))).size).toBeLessThanOrEqual(2048);
  } finally { server.stop(true); await job.close(); }
}, 20_000);

test('streams a finite HLS source through FFmpeg into the bounded workspace', async () => {
  const input = await fixture('hls-source.mp4', {audio: true});
  const workDir = await mkdtemp(join(dir, 'hls-'));
  await exec('ffmpeg', ['-v', 'error', '-i', input, '-c', 'copy', '-f', 'hls',
    '-hls_list_size', '0', join(workDir, 'clip.m3u8')]);
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch: request => {
    return new Response(Bun.file(join(workDir, basename(new URL(request.url).pathname))));
  }});
  const job = new SaveJob();
  try {
    const meta = parseMetadata({id: 'clip', title: 'clip', duration: 2, extractor: 'generic', extractor_key: 'Generic',
      formats: [{format_id: 'hls', protocol: 'm3u8_native', url: new URL('clip.m3u8', server.url).href,
        ext: 'mp4', width: 640, height: 360, vcodec: 'avc1', acodec: 'mp4a'}]});
    const infoPath = join(workDir, 'info.json');
    await writeFile(infoPath, JSON.stringify(meta.raw));
    const [path] = await downloadTracks(job, selectFormats(meta, 2_000_000), infoPath, workDir, 2_000_000, () => {});
    const media = await probeMedia(job, path!);
    expect(media.video).toBe(true);
    expect(media.audio).toBe(true);
    expect(media.duration).toBeCloseTo(2, 0);
  } finally { server.stop(true); await job.close(); }
}, 20_000);
