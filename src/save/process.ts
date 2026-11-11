import {spawn} from 'node:child_process';
import type {ChildProcessWithoutNullStreams} from 'node:child_process';

import {SaveError} from './errors';
import type {SaveErrorCode} from './errors';
import {MiB, PROCESSING_MS} from './policy';

interface RunOptions {
  cwd?: string;
  maxBytes?: number;
  timeoutMs?: number;
  errorCode?: SaveErrorCode;
  onData?: (chunk: Buffer) => Promise<void>;
  onLine?: (line: string) => void;
  linesFrom?: 'stdout'|'stderr';
}

// All media subprocesses live in their own Linux process group. Cleanup also
// reaches downloader-spawned ffmpeg instances that a direct child.kill misses.
export class SaveJob {
  readonly signal: AbortSignal;
  readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<Buffer>>();
  private closed = false;

  constructor(options: {signal?: AbortSignal; deadline?: number} = {}) {
    this.signal = options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal;
    this.deadline = options.deadline ?? performance.now() + PROCESSING_MS;
  }

  abort(reason: SaveError): void { this.controller.abort(reason); }

  check(): void {
    if (this.signal.aborted) throw this.signal.reason instanceof SaveError ? this.signal.reason : new SaveError('shutdown');
    if (this.closed) throw new SaveError('shutdown');
    if (performance.now() >= this.deadline) throw new SaveError('timeout');
  }

  run(command: string, args: string[], options: RunOptions = {}): Promise<Buffer> {
    const promise = this.execute(command, args, options);
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
    return promise;
  }

  private async execute(command: string, args: string[], options: RunOptions): Promise<Buffer> {
    this.check();
    const errorCode = options.errorCode ?? 'encode';
    const timeoutMs = Math.min(options.timeoutMs ?? 180_000, this.deadline - performance.now());
    const child = spawn(command, args, {cwd: options.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    child.stdin.end();
    let failure: SaveError|undefined;
    let exited = false;
    const exit = new Promise<number|null>(resolve => {
      child.once('error', () => { failure ??= new SaveError(errorCode, `${command} could not start`); });
      child.once('close', code => { exited = true; resolve(code); });
    });
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try { process.kill(-child.pid, signal); } catch { if (!exited) child.kill(signal); }
      }
    };
    let escalation: ReturnType<typeof setTimeout>|undefined;
    const stop = (reason: SaveError) => {
      failure ??= reason;
      kill('SIGTERM');
      escalation ??= setTimeout(() => kill('SIGKILL'), 300);
    };
    const onAbort = () => stop(this.signal.reason instanceof SaveError ? this.signal.reason : new SaveError('shutdown'));
    this.signal.addEventListener('abort', onAbort, {once: true});
    if (this.signal.aborted) onAbort();
    const timeout = setTimeout(() => stop(new SaveError('timeout')), Math.max(1, timeoutMs));
    const buffers: Buffer[] = [];
    let total = 0;
    const maxBytes = options.maxBytes ?? 8 * MiB;
    const makeLineReader = () => {
      let pending = '';
      return (text: string, last = false) => {
        // Bound a malformed line independently from the total drained output.
        pending = (pending + text).slice(-16_384);
        const lines = pending.split(/[\r\n]/);
        pending = lines.pop() ?? '';
        for (const line of lines) if (line) options.onLine?.(line.trim());
        if (last && pending) options.onLine?.(pending.trim());
      };
    };
    const lines = makeLineReader();
    const readOutput = async () => {
      for await (const data of child.stdout) {
        if (failure) break;
        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (total + chunk.length > maxBytes) {
          stop(new SaveError('limit', 'Output byte cap exceeded', total + chunk.length, maxBytes));
          break;
        }
        total += chunk.length;
        if (options.onLine && options.linesFrom !== 'stderr') lines(chunk.toString());
        if (options.onData) await options.onData(chunk);
        else buffers.push(chunk);
      }
      if (options.linesFrom !== 'stderr') lines('', true);
    };
    const readErrors = async () => {
      for await (const data of child.stderr) {
        if (options.linesFrom === 'stderr') lines(data.toString());
        // Always drain stderr. Neither raw signed URLs nor unbounded diagnostics
        // are retained or included in errors/logs.
      }
      if (options.linesFrom === 'stderr') lines('', true);
    };
    try {
      const results = await Promise.all([readOutput(), readErrors(), exit]);
      if (failure) throw failure;
      if (results[2] !== 0) throw new SaveError(errorCode, `${command} exited with code ${results[2]}`);
      return Buffer.concat(buffers, options.onData ? 0 : total);
    } catch (error) {
      stop(error instanceof SaveError ? error : new SaveError(errorCode));
      throw failure;
    } finally {
      clearTimeout(timeout);
      this.signal.removeEventListener('abort', onAbort);
      // Killing an exited group is safe and removes any surviving descendant.
      kill('SIGKILL');
      if (escalation) clearTimeout(escalation);
      if (!exited) {
        await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 2000))]);
      }
      this.destroyPipes(child);
    }
  }

  private destroyPipes(child: ChildProcessWithoutNullStreams): void {
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort(new SaveError('shutdown'));
    await Promise.allSettled([...this.pending]);
  }
}
