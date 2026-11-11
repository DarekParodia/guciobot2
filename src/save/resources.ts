import {chmod, mkdtemp, readFile, readdir, realpath, rm, stat, statfs} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, relative, resolve} from 'node:path';

import {SaveError} from './errors';
import {AUXILIARY_BYTES, MiB, object, sourceBudget} from './policy';
import type {SaveConfig} from './policy';

type ReadText = (path: string) => Promise<string>;
const readText: ReadText = path => readFile(path, 'utf8');

function unescapeMount(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

export async function getMemoryHeadroom(read: ReadText = readText): Promise<number> {
  try {
    const [meminfo, membership, mounts] = await Promise.all([
      read('/proc/meminfo'), read('/proc/self/cgroup'), read('/proc/self/mountinfo'),
    ]);
    const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(meminfo)?.[1];
    if (!available) throw new Error('Missing MemAvailable');
    let headroom = Number(available) * 1024;
    const groups = membership.trim().split('\n').map(line => line.split(':'));
    const memoryGroup = groups.find(fields => fields[1]?.split(',').includes('memory'));
    const unified = groups.find(fields => fields[0] === '0' && fields[1] === '');
    const group = memoryGroup ?? unified;
    if (!group?.[2]) return headroom;
    const v2 = !memoryGroup;
    const mount = mounts.split('\n').map(line => line.split(' - ')).find(parts => {
      const fields = parts[1]?.split(' ');
      return v2 ? fields?.[0] === 'cgroup2' : fields?.[0] === 'cgroup' && fields[2]?.split(',').includes('memory');
    });
    if (!mount?.[0]) throw new Error('Missing cgroup mount');
    const fields = mount[0].split(' ');
    const root = unescapeMount(fields[3] ?? '');
    const mountpoint = unescapeMount(fields[4] ?? '');
    if (!root.startsWith('/') || !mountpoint.startsWith('/')) throw new Error('Invalid cgroup mount');
    const groupPath = group[2];
    const suffix = groupPath === '/' ? '' : root === '/' ? groupPath.slice(1) : relative(root, groupPath);
    if (suffix.startsWith('..')) throw new Error('Cgroup path outside mount');
    let path = resolve(mountpoint, suffix);
    for (;;) {
      const limitName = v2 ? 'memory.max' : 'memory.limit_in_bytes';
      const usageName = v2 ? 'memory.current' : 'memory.usage_in_bytes';
      let maximum: string;
      try {
        maximum = (await read(join(path, limitName))).trim();
      } catch (error) {
        if (!v2 || object(error).code !== 'ENOENT') throw error;
        const controllers = (await read(join(path, 'cgroup.controllers'))).trim().split(/\s+/);
        // The hierarchy root has no memory.max. A child may also lack it
        // when its parent has not delegated memory, but an ancestor can cap it.
        if (controllers.includes('memory') && !(path === mountpoint && root === '/')) throw error;
        maximum = 'max';
      }
      if (maximum !== 'max') {
        if (!/^\d+$/.test(maximum)) throw new Error('Invalid memory limit');
        const limit = BigInt(maximum);
        if (limit < BigInt(Number.MAX_SAFE_INTEGER)) {
          const usage = (await read(join(path, usageName))).trim();
          if (!/^\d+$/.test(usage)) throw new Error('Invalid memory usage');
          headroom = Math.min(headroom, Math.max(0, Number(limit - BigInt(usage))));
        }
      }
      if (path === mountpoint) break;
      const parent = dirname(path);
      if (parent === path || relative(mountpoint, parent).startsWith('..')) throw new Error('Invalid cgroup ancestor');
      path = parent;
    }
    if (!Number.isFinite(headroom) || headroom < 0) throw new Error('Invalid memory headroom');
    return headroom;
  } catch {
    throw new SaveError('memory');
  }
}

export interface Workspace {
  path: string;
  inputLimit: number;
  workspaceLimit: number;
  cleanup(): Promise<void>;
}

export async function createWorkspace(config: SaveConfig, limit: number): Promise<Workspace> {
  const candidates = config.tmpfsDir ? [config.tmpfsDir] : ['/dev/shm', tmpdir()];
  for (const candidate of candidates) {
    let path: string|undefined;
    try {
      const base = await realpath(candidate);
      const fs = await statfs(base);
      if (Number(fs.type) !== 0x01021994) continue;
      const memory = await getMemoryHeadroom();
      const inputLimit = sourceBudget(memory, fs.bavail * fs.bsize, limit, config);
      path = await mkdtemp(join(base, 'guciobot-save-'));
      await chmod(path, 0o700);
      return {path, inputLimit, workspaceLimit: inputLimit + 2 * limit + AUXILIARY_BYTES,
        cleanup: () => rm(path!, {recursive: true, force: true})};
    } catch {
      if (path) await rm(path, {recursive: true, force: true});
    }
  }
  throw new SaveError('memory');
}

export async function checkResources(workspace: Workspace): Promise<void> {
  const [memory, fs, files] = await Promise.all([
    getMemoryHeadroom(), statfs(workspace.path), readdir(workspace.path),
  ]);
  const sizes = await Promise.all(files.map(async file => {
    try { return (await stat(join(workspace.path, file))).size; } catch (error) {
      // FFmpeg atomically renames/deletes pass-log files between these calls.
      if (object(error).code === 'ENOENT') return 0;
      throw error;
    }
  }));
  if (memory < 128 * MiB || fs.bavail * fs.bsize < MiB ||
      sizes.reduce((a, b) => a + b, 0) > workspace.workspaceLimit) {
    throw new SaveError('memory');
  }
}
