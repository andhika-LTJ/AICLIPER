import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AdminOverviewData } from '../src/types/clipper.ts';
import type { KlipCastDatabase } from './db.ts';
import {
  getAvailableFfmpegPathSync,
  getAvailableFfprobePathSync,
} from './ffmpegBinaries.ts';

export function getDirectorySizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      try {
        if (entry.isDirectory()) {
          total += getDirectorySizeBytes(full);
        } else if (entry.isFile()) {
          total += fs.statSync(full).size;
        }
      } catch {
        // Skip transient temp files
      }
    }
  } catch {
    return 0;
  }
  return total;
}

export function getDiskSpaceStats(targetDir: string): {
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
} {
  try {
    if (typeof fs.statfsSync === 'function') {
      const dir = fs.existsSync(targetDir) ? targetDir : process.cwd();
      const stat = fs.statfsSync(dir);
      const bsize = Number(stat.bsize);
      const blocks = Number(stat.blocks);
      const bavail = Number(stat.bavail);
      if (Number.isFinite(bsize) && Number.isFinite(blocks) && Number.isFinite(bavail)) {
        return {
          diskTotalBytes: bsize * blocks,
          diskFreeBytes: bsize * bavail,
        };
      }
    }
  } catch {
    // Platform without statfsSync
  }
  return { diskFreeBytes: null, diskTotalBytes: null };
}

export function buildRealAdminOverview(db: KlipCastDatabase): AdminOverviewData {
  const dbMetrics = db.getAdminMetricsSummary();
  const dataDir = db.dataDir;
  const rendersDir = path.join(dataDir, 'renders');
  const uploadsDir = path.join(dataDir, 'uploads');

  const mem = process.memoryUsage();
  const load = os.loadavg();
  const disk = getDiskSpaceStats(dataDir);

  return {
    users: dbMetrics.users,
    content: dbMetrics.content,
    renders: dbMetrics.renders,
    ai: dbMetrics.ai,
    storage: {
      dataDirBytes: getDirectorySizeBytes(dataDir),
      rendersDirBytes: getDirectorySizeBytes(rendersDir),
      uploadsDirBytes: getDirectorySizeBytes(uploadsDir),
      diskFreeBytes: disk.diskFreeBytes,
      diskTotalBytes: disk.diskTotalBytes,
    },
    system: {
      uptimeSec: Math.floor(process.uptime()),
      nodeVersion: process.version,
      memoryRssMb: Math.round((mem.rss / (1024 * 1024)) * 10) / 10,
      heapUsedMb: Math.round((mem.heapUsed / (1024 * 1024)) * 10) / 10,
      cpuCount: os.cpus()?.length || 1,
      loadAvg1m: Number((load[0] ?? 0).toFixed(2)),
      dbStatus: db.checkHealth() ? 'healthy' : 'error',
      dbEngine: 'SQLite WAL (node:sqlite)',
      geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
      ffmpegReady: Boolean(getAvailableFfmpegPathSync()),
      ffprobeReady: Boolean(getAvailableFfprobePathSync()),
    },
  };
}
