export const HEARTBEAT_QUEUE = 'heartbeat';
export const HEARTBEAT_JOB = 'heartbeat';
export const HEARTBEAT_SCHEDULER_ID = 'heartbeat-every-30s';
export const HEARTBEAT_EVERY_MS = 30_000;

export interface HeartbeatResult {
  processedAt: string;
  pid: number;
}
