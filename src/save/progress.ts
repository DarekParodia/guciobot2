// Discord-independent serialization: close() is a barrier before the final
// response, and deliberately discards queued intermediate edits.
export function createProgressReporter(send: (text: string) => Promise<unknown>, intervalMs = 2000) {
  let lastSent = -Infinity;
  let queued: string|null = null;
  let timer: ReturnType<typeof setTimeout>|undefined;
  let inFlight: Promise<unknown>|undefined;
  let closed = false;

  const schedule = () => {
    if (closed || timer || inFlight || queued === null) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (closed || queued === null) return;
      const text = queued;
      queued = null;
      lastSent = performance.now();
      inFlight = Promise.resolve().then(() => send(text)).catch(() => {
        // Progress is best effort; terminal delivery reports its own failure.
      }).finally(() => { inFlight = undefined; schedule(); });
    }, Math.max(0, lastSent + intervalMs - performance.now()));
  };

  return {
    update(text: string): void {
      if (closed) return;
      queued = text;
      schedule();
    },
    async close(): Promise<void> {
      closed = true;
      queued = null;
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
