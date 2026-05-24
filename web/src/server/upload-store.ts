// Filesystem store for uploaded Excel buffers. We need to replay the same
// file through LineWise when the user declares an incident (/urgencias)
// AFTER the original upload (/validar). The Excel buffer is dropped after
// parsing today, so we cache it here keyed by planId.
//
// Stored under web/uploads/ (gitignored). Each entry is the raw .xlsx bytes
// the user uploaded — same one that originally went to LineWise.

import { promises as fs } from 'fs';
import path from 'path';

const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

async function ensureDir() {
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
}

export async function saveUpload(planId: string, fileName: string, buf: Buffer): Promise<void> {
  await ensureDir();
  // Store as {planId}.xlsx; also keep the original filename as a sidecar
  // .meta.json so /urgencias can echo it back to LineWise (the model uses
  // it only for display in the swap_log — small detail but kept honest).
  const xlsxPath = path.join(UPLOADS_DIR, `${planId}.xlsx`);
  const metaPath = path.join(UPLOADS_DIR, `${planId}.meta.json`);
  await fs.writeFile(xlsxPath, buf);
  await fs.writeFile(metaPath, JSON.stringify({ fileName, savedAt: new Date().toISOString() }));
}

export interface LoadedUpload {
  buffer: Buffer;
  fileName: string;
}

export async function loadUpload(planId: string): Promise<LoadedUpload | null> {
  const xlsxPath = path.join(UPLOADS_DIR, `${planId}.xlsx`);
  const metaPath = path.join(UPLOADS_DIR, `${planId}.meta.json`);
  try {
    const buffer = await fs.readFile(xlsxPath);
    let fileName = `${planId}.xlsx`;
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
      if (meta?.fileName && typeof meta.fileName === 'string') fileName = meta.fileName;
    } catch {
      // meta file optional — fall back to planId
    }
    return { buffer, fileName };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
}
