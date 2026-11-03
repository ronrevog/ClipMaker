// Vercel Serverless Function: /api/upload-video
// Uploads source video files to Vercel Blob Storage (@vercel/blob) when BLOB_READ_WRITE_TOKEN is configured,
// returning a permanent cloud video URL so saved projects can be recalled from any device.

import { put } from '@vercel/blob';

export async function handleUploadVideoBlob(
  fileName: string,
  contentType: string,
  buffer: Buffer
): Promise<{ ok: boolean; blobUrl?: string; error?: string }> {
  const hasBlob = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_READ_WRITE_TOKEN.trim().length > 10
  );
  if (!hasBlob) {
    return {
      ok: false,
      error: 'BLOB_READ_WRITE_TOKEN not configured (using local IndexedDB video persistence)',
    };
  }

  const safeName = (fileName || 'video.mp4').replace(/[^a-zA-Z0-9._-]+/g, '_');
  const blob = await put(`clipmaker-videos/${Date.now()}-${safeName}`, buffer, {
    access: 'public',
    contentType: contentType || 'video/mp4',
  });

  return { ok: true, blobUrl: blob.url };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  try {
    const urlObj = new URL(req.url || '/api/upload-video', 'http://localhost');
    const fileName = urlObj.searchParams.get('filename') || 'video.mp4';
    const contentType = req.headers['content-type'] || 'video/mp4';

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);
    const result = await handleUploadVideoBlob(fileName, contentType, buffer);

    res.statusCode = result.ok ? 200 : 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'Video upload error' }));
  }
}
