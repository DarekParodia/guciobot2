// Minimal tagged console logger. Keeps log call sites short while making it
// obvious which module produced a given line.
export function createLogger(tag: string) {
  const prefix = `[${tag}]`;
  return {
    info: (...args: unknown[]) => console.log(prefix, ...args),
    warn: (...args: unknown[]) => console.warn(prefix, ...args),
    error: (...args: unknown[]) => console.error(prefix, ...args),
  };
}

export type Logger = ReturnType<typeof createLogger>;
