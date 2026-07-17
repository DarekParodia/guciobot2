export interface YtVideo {
  url: string;
  title: string;
  duration: number;
  durationString: string;
  // Optional start position in seconds
  startSeconds?: number;
  onEnd?: () => Promise<void>;
  onStart?: () => Promise<void>;
}
