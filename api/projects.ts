// Vercel Serverless Function: /api/projects
// Persists and recalls ClipMaker Studio projects using Vercel Blob Storage (@vercel/blob)
// when BLOB_READ_WRITE_TOKEN is configured on Vercel, with automatic local disk fallback (.data/projects.json).

import fs from 'fs';
import path from 'path';
import os from 'os';
import { del, list, put } from '@vercel/blob';

export interface SavedProjectRecord {
  id: string;
  name: string;
  ownerEmail: string;
  ownerName: string;
  updatedAt: string;
  createdAt: string;
  sourceFileName: string;
  sourceDuration: number;
  clipsCount: number;
  focusLocksCount: number;
  projectState: any;
}

function hasVercelBlobToken(): boolean {
  return Boolean(
    process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_READ_WRITE_TOKEN.trim().length > 10
  );
}

function getLocalStorePath(): string {
  try {
    const localDir = path.join(process.cwd(), '.data');
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    return path.join(localDir, 'clipmaker-projects.json');
  } catch {
    return path.join(os.tmpdir(), 'clipmaker-projects.json');
  }
}

function readLocalProjects(): SavedProjectRecord[] {
  try {
    const file = getLocalStorePath();
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeLocalProjects(projects: SavedProjectRecord[]): void {
  try {
    const file = getLocalStorePath();
    fs.writeFileSync(file, JSON.stringify(projects, null, 2), 'utf8');
  } catch (e) {
    console.warn('Could not write local projects file:', e);
  }
}

export async function handleProjectsRequest(
  method: string,
  query: Record<string, string | undefined>,
  body: any
): Promise<any> {
  const useBlob = hasVercelBlobToken();

  // GET /api/projects or GET /api/projects?id=...
  if (method === 'GET') {
    const targetId = query.id;

    if (useBlob) {
      try {
        const { blobs } = await list({ prefix: 'clipmaker-projects/' });
        if (targetId) {
          const match = blobs.find((b) => b.pathname === `clipmaker-projects/${targetId}.json`);
          if (!match) return { ok: false, error: 'Project not found in Vercel Blob' };
          const resp = await fetch(match.url);
          const project = await resp.json();
          return { ok: true, project, storageBackend: 'vercel-blob' };
        }

        const summaries: SavedProjectRecord[] = [];
        for (const b of blobs.slice(0, 40)) {
          try {
            const r = await fetch(b.url);
            const proj = (await r.json()) as SavedProjectRecord;
            if (proj && proj.id) {
              summaries.push({
                ...proj,
                projectState: undefined, // Keep list response lightweight
              });
            }
          } catch {}
        }
        summaries.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        return { ok: true, projects: summaries, storageBackend: 'vercel-blob' };
      } catch (e: any) {
        console.warn('Vercel Blob list fallback to local:', e?.message);
      }
    }

    const all = readLocalProjects();
    if (targetId) {
      const found = all.find((p) => p.id === targetId);
      if (!found) return { ok: false, error: 'Project not found' };
      return { ok: true, project: found, storageBackend: 'server-local' };
    }

    const summaries = all
      .map((p) => ({ ...p, projectState: undefined }))
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return { ok: true, projects: summaries, storageBackend: 'server-local' };
  }

  // POST /api/projects (Save or Update project)
  if (method === 'POST') {
    const record: SavedProjectRecord = body?.project;
    if (!record || !record.id) {
      return { ok: false, error: 'Missing project payload' };
    }

    const now = new Date().toISOString();
    const normalized: SavedProjectRecord = {
      ...record,
      updatedAt: now,
      createdAt: record.createdAt || now,
    };

    if (useBlob) {
      try {
        await put(
          `clipmaker-projects/${normalized.id}.json`,
          JSON.stringify(normalized),
          {
            access: 'public',
            addRandomSuffix: false,
            contentType: 'application/json',
          }
        );
        return {
          ok: true,
          project: { ...normalized, projectState: undefined },
          storageBackend: 'vercel-blob',
        };
      } catch (e: any) {
        console.warn('Vercel Blob save fallback to local:', e?.message);
      }
    }

    const all = readLocalProjects().filter((p) => p.id !== normalized.id);
    all.unshift(normalized);
    writeLocalProjects(all.slice(0, 50));
    return {
      ok: true,
      project: { ...normalized, projectState: undefined },
      storageBackend: 'server-local',
    };
  }

  // DELETE /api/projects?id=...
  if (method === 'DELETE') {
    const targetId = query.id || body?.id;
    if (!targetId) return { ok: false, error: 'Missing project id' };

    if (useBlob) {
      try {
        const { blobs } = await list({ prefix: `clipmaker-projects/${targetId}.json` });
        for (const b of blobs) {
          await del(b.url);
        }
      } catch {}
    }

    const remaining = readLocalProjects().filter((p) => p.id !== targetId);
    writeLocalProjects(remaining);
    return { ok: true, deletedId: targetId };
  }

  return { ok: false, error: 'Unsupported method' };
}

export default async function handler(req: any, res: any) {
  try {
    const urlObj = new URL(req.url || '/api/projects', 'http://localhost');
    const query: Record<string, string | undefined> = {
      id: urlObj.searchParams.get('id') || undefined,
    };
    const body =
      typeof req.body === 'string' && req.body.length > 0
        ? JSON.parse(req.body)
        : req.body || {};

    const result = await handleProjectsRequest(req.method || 'GET', query, body);
    res.statusCode = result.ok ? 200 : 400;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'Projects API error' }));
  }
}
