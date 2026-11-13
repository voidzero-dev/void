export const fontCounts = [10, 25, 50, 100, 250, 500];

export interface FontMemorySample {
  pid: number;
  startedAt: number;
  sampledAt: number;
  uptime: number;
  rss: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  fontBytes: number;
  rendered: number;
  running: boolean;
  completed: number;
  requested: number;
  warmed: boolean;
  gcAvailable: boolean;
  imageHash: string | null;
}
