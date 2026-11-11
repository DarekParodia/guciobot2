import {SaveError} from './errors';
import {prepareVideo} from './media';
import type {Progress, SavedVideo} from './media';
import {getOutputLimit, getSaveConfig, PROCESSING_MS} from './policy';
import {SaveJob} from './process';
import {checkResources, createWorkspace} from './resources';
import type {Workspace} from './resources';

type Prepare = typeof prepareVideo;
type Deliver = (video: SavedVideo, signal: AbortSignal) => Promise<void>;

export class SaveService {
  private active: {controller: AbortController; promise: Promise<void>}|null = null;
  private stopping = false;

  constructor(private readonly prepare: Prepare = prepareVideo) {}

  save(url: string, discordLimit: number, progress: Progress, deliver: Deliver,
       startedAt = performance.now()): Promise<void> {
    if (this.stopping) return Promise.reject(new SaveError('shutdown'));
    if (this.active) return Promise.reject(new SaveError('busy'));
    const controller = new AbortController();
    const promise = this.execute(url, discordLimit, progress, deliver, startedAt, controller.signal)
        .finally(() => { this.active = null; });
    this.active = {controller, promise};
    return promise;
  }

  private async execute(url: string, discordLimit: number, progress: Progress, deliver: Deliver,
                        startedAt: number, signal: AbortSignal): Promise<void> {
    let workspace: Workspace|undefined;
    let monitor: ReturnType<typeof setInterval>|undefined;
    let checking: Promise<void>|undefined;
    const job = new SaveJob({signal, deadline: startedAt + PROCESSING_MS});
    try {
      let parsed: URL;
      try { parsed = new URL(url); } catch { throw new SaveError('input'); }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new SaveError('input');
      const limit = getOutputLimit(discordLimit);
      workspace = await createWorkspace(await getSaveConfig(), limit);
      const currentWorkspace = workspace;
      monitor = setInterval(() => {
        if (checking) return;
        checking = checkResources(currentWorkspace).catch(() => job.abort(new SaveError('memory')))
            .finally(() => { checking = undefined; });
      }, 500);
      await checkResources(workspace);
      const result = await this.prepare(job, url, limit, workspace, progress);
      job.check();
      await checkResources(workspace);
      const remaining = Math.min(120_000, startedAt + 12 * 60_000 - performance.now());
      if (remaining <= 0) throw new SaveError('timeout');
      const uploadSignal = AbortSignal.any([job.signal, AbortSignal.timeout(Math.ceil(remaining))]);
      progress({stage: 'upload', size: result.size, limit});
      await deliver(result, uploadSignal);
    } finally {
      if (monitor) clearInterval(monitor);
      await checking;
      await job.close();
      await workspace?.cleanup();
    }
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const active = this.active;
    active?.controller.abort(new SaveError('shutdown'));
    if (active) await active.promise.catch(() => {});
  }
}

export const saveService = new SaveService();
export const shutdownSaves = () => saveService.shutdown();
