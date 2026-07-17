import {insertLog} from './db';
import type {LogLevel} from './db';

// Turns console.log-style varargs into one string for the sqlite `logs`
// table. Errors keep their stack trace; anything else is stringified.
function serializeArgs(args: unknown[]): string {
  return args
      .map(arg => {
        if (arg instanceof Error) return arg.stack ?? arg.message;
        if (typeof arg === 'string') return arg;
        try {
          return JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' ');
}

// Tagged logger: prints to the console as before, and additionally persists
// every call to sqlite (see src/db.ts) so logs survive a restart and can be
// queried later — not just tailed live.
export function createLogger(tag: string) {
  const prefix = `[${tag}]`;

  const log = (level: LogLevel, args: unknown[]) => {
    insertLog(level, tag, serializeArgs(args));
  };

  return {
    info: (...args: unknown[]) => {
      console.log(prefix, ...args);
      log('info', args);
    },
    warn: (...args: unknown[]) => {
      console.warn(prefix, ...args);
      log('warn', args);
    },
    error: (...args: unknown[]) => {
      console.error(prefix, ...args);
      log('error', args);
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
