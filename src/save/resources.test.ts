import {expect, test} from 'bun:test';
import {mkdtemp, rm, stat, statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {parseSaveConfig} from './policy';
import {createWorkspace, getMemoryHeadroom} from './resources';

test('cgroup v2 ancestor allowance constrains host MemAvailable', async () => {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemAvailable: 8000000 kB\n',
    '/proc/self/cgroup': '0::/parent/job\n',
    '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/parent/job/memory.max': 'max',
    '/sys/fs/cgroup/parent/job/memory.current': '100',
    '/sys/fs/cgroup/parent/memory.max': '2000000000',
    '/sys/fs/cgroup/parent/memory.current': '1500000000',
    '/sys/fs/cgroup/memory.max': 'max',
    '/sys/fs/cgroup/memory.current': '100',
  };
  expect(await getMemoryHeadroom(async path => {
    if (!(path in files)) throw new Error(`Missing fixture ${path}`);
    return files[path]!;
  })).toBe(500_000_000);
  delete files['/sys/fs/cgroup/parent/memory.max'];
  await expect(getMemoryHeadroom(async path => {
    if (!(path in files)) throw new Error('unreadable');
    return files[path]!;
  })).rejects.toThrow();
});

test('cgroup v1 namespace mount root and unlimited sentinel are understood', async () => {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemAvailable: 1000000 kB\n',
    '/proc/self/cgroup': '3:memory:/container/job\n',
    '/proc/self/mountinfo': '1 0 0:1 /container /sys/fs/cgroup/memory rw - cgroup cgroup rw,memory\n',
    '/sys/fs/cgroup/memory/job/memory.limit_in_bytes': '9223372036854771712',
    '/sys/fs/cgroup/memory/job/memory.usage_in_bytes': '10',
    '/sys/fs/cgroup/memory/memory.limit_in_bytes': '1000000000',
    '/sys/fs/cgroup/memory/memory.usage_in_bytes': '900000000',
  };
  expect(await getMemoryHeadroom(async path => files[path] ?? Promise.reject(new Error(path)))).toBe(100_000_000);
});

test('cgroup v2 inherits a parent limit without a local memory controller', async () => {
  const files: Record<string, string> = {
    '/proc/meminfo': 'MemAvailable: 8000000 kB\n',
    '/proc/self/cgroup': '0::/parent/job\n',
    '/proc/self/mountinfo': '1 0 0:1 / /sys/fs/cgroup rw - cgroup2 cgroup rw\n',
    '/sys/fs/cgroup/parent/job/cgroup.controllers': 'cpu io',
    '/sys/fs/cgroup/parent/memory.max': '1000000000',
    '/sys/fs/cgroup/parent/memory.current': '750000000',
    '/sys/fs/cgroup/cgroup.controllers': 'cpu memory io',
  };
  const read = async (path: string) => {
    if (path in files) return files[path]!;
    throw Object.assign(new Error('Missing file'), {code: 'ENOENT'});
  };
  expect(await getMemoryHeadroom(read)).toBe(250_000_000);
  await expect(getMemoryHeadroom(async path => {
    if (path === '/sys/fs/cgroup/memory.max') throw Object.assign(new Error('Denied'), {code: 'EACCES'});
    return read(path);
  })).rejects.toMatchObject({code: 'memory'});
});

test('workspace is private verified tmpfs and cleans up', async () => {
  // /tmp is verified by production code; this Linux project requires tmpfs.
  const dir = await mkdtemp(join(tmpdir(), 'save-workspace-test-'));
  try {
    const workspace = await createWorkspace(parseSaveConfig({save: {tmpfsDir: dir}}), 20_000_000);
    expect(workspace.inputLimit).toBeGreaterThan(0);
    expect(workspace.path.startsWith(dir + '/')).toBe(true);
    expect((await stat(workspace.path)).mode & 0o777).toBe(0o700);
    await workspace.cleanup();
    await expect(stat(workspace.path)).rejects.toThrow();
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
});

test('an explicitly selected regular filesystem never receives source files', async () => {
  const root = process.cwd();
  if (Number((await statfs(root)).type) === 0x01021994) return;
  await expect(createWorkspace(parseSaveConfig({save: {tmpfsDir: root}}), 20_000_000)).rejects.toMatchObject({code: 'memory'});
});
