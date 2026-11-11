import { Channel, invoke } from '@tauri-apps/api/core';
import type { Report } from './report';

export type DistributionInfo = {
  version: string;
  platform: string;
  reportingEnabled: boolean;
  updaterEnabled: boolean;
};
export type AvailableUpdate = { version: string; notes: string | null };
export type DownloadEvent = { kind: 'progress'; received: number; total: number | null } | { kind: 'verifying' };

export const distribution = {
  info: () => invoke<DistributionInfo>('distribution_info'),
  submitReport: (report: Report) => invoke<unknown>('submit_report', { report }),
  check: () => invoke<AvailableUpdate | null>('check_update'),
  download: (version: string, onEvent: (event: DownloadEvent) => void) =>
    invoke<void>('download_update', { version, events: new Channel(onEvent) }),
  install: (version: string) => invoke<void>('install_update', { version }),
};
