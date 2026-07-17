// Parses timestamps like "1:23", "1:02:30", or a plain number of seconds.
// Returns NaN for anything unparseable.
export function parseTimestampToSeconds(input: string): number {
  const parts = input.split(':').map(p => p.trim());
  if (parts.length === 1) {
    const n = Number(parts[0]);
    return isNaN(n) ? NaN : Math.floor(n);
  }

  // Support mm:ss or hh:mm:ss
  let seconds = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = Number(parts[parts.length - 1 - i]);
    if (isNaN(part)) return NaN;
    seconds += part * Math.pow(60, i);
  }
  return Math.floor(seconds);
}

// Formats a duration in seconds as "Hh Mm Ss" (hours omitted when zero).
// Unlike `Date#toISOString`, this has no 24-hour ceiling.
export function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);

  return hours > 0 ? `${hours}h ${minutes}m ${seconds}s` : `${minutes}m ${seconds}s`;
}
