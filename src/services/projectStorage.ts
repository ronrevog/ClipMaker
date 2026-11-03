import {
  CopilotChatMessage,
  EditingScheme,
  GeneratedClip,
  SourceVideoAsset,
} from '../types/editor';

export interface ComplexAuthUser {
  email: string;
  name: string;
  picture?: string;
  domain: string;
  signedInAt: string;
  token: string;
}

export interface ClipMakerProjectState {
  sourceAsset: Omit<SourceVideoAsset, 'url'> & { cloudVideoUrl?: string };
  fullVideoClip: GeneratedClip | null;
  generatedClips: GeneratedClip[];
  activeClipId: string | null;
  timelineMode: 'full-source' | 'elected-clip';
  activeScheme: EditingScheme;
  inMarker: number | null;
  outMarker: number | null;
  chatMessages: CopilotChatMessage[];
}

export interface SavedProjectSummary {
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
  storageLocation?: 'vercel-cloud' | 'local-indexeddb';
  projectState?: ClipMakerProjectState;
}

const AUTH_STORAGE_KEY = 'clipmaker_complex_auth_user_v1';
const LAST_ACTIVE_PROJECT_KEY = 'clipmaker_last_project_id_v1';
const IDB_NAME = 'ClipMakerStudioDB';
const IDB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_VIDEOS = 'video_blobs';

// ============================================================================
// 1. @complex.com Authentication Client
// ============================================================================

export function isComplexDomainEmail(email: string): boolean {
  const cleaned = (email || '').trim().toLowerCase();
  const parts = cleaned.split('@');
  return parts.length === 2 && parts[0].length > 0 && parts[1] === 'complex.com';
}

export function loadSavedAuthUser(): ComplexAuthUser | null {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ComplexAuthUser;
    if (!parsed?.email || !isComplexDomainEmail(parsed.email)) {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function verifyGoogleIdTokenWithServer(
  credential: string,
  clientId?: string
): Promise<{ ok: boolean; user?: ComplexAuthUser; error?: string }> {
  try {
    const resp = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'google-id-token',
        credential,
        clientId,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok || !data.user) {
      return {
        ok: false,
        error:
          data.error ||
          'Google authentication failed. You must sign in with a @complex.com Google Workspace account.',
      };
    }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data.user));
    return { ok: true, user: data.user };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || 'Could not reach authentication server.',
    };
  }
}

export function saveVerifiedComplexUser(params: {
  email: string;
  name?: string | null;
  picture?: string | null;
  token: string;
}): ComplexAuthUser {
  const email = params.email.trim().toLowerCase();
  const user: ComplexAuthUser = {
    email,
    name:
      (params.name || '').trim() ||
      email
        .split('@')[0]
        .replace(/[._-]+/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase()),
    picture: params.picture || undefined,
    domain: 'complex.com',
    signedInAt: new Date().toISOString(),
    token: params.token,
  };
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(user));
  return user;
}

export async function verifyFirebaseIdTokenWithServer(
  firebaseIdToken: string
): Promise<{ ok: boolean; user?: ComplexAuthUser; error?: string }> {
  try {
    const resp = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'firebase-id-token',
        firebaseIdToken,
      }),
    });
    const text = await resp.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch {
      return {
        ok: false,
        error: `Server returned status ${resp.status}`,
      };
    }
    if (!resp.ok || !data?.ok || !data?.user) {
      return {
        ok: false,
        error:
          data?.error ||
          'Google authentication failed. You must sign in with a @complex.com Google Workspace account.',
      };
    }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data.user));
    return { ok: true, user: data.user };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || 'Could not reach authentication server.',
    };
  }
}

export async function verifyGoogleAccessTokenWithServer(
  accessToken: string
): Promise<{ ok: boolean; user?: ComplexAuthUser; error?: string }> {
  try {
    const resp = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'google-access-token',
        accessToken,
      }),
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok || !data.user) {
      return {
        ok: false,
        error:
          data.error ||
          'Google authentication failed. You must sign in with a @complex.com Google Workspace account.',
      };
    }
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(data.user));
    return { ok: true, user: data.user };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message || 'Could not reach authentication server.',
    };
  }
}

export function signOutComplexUser(): void {
  localStorage.removeItem(AUTH_STORAGE_KEY);
  try {
    const g = (window as any).google;
    if (g?.accounts?.id) {
      g.accounts.id.disableAutoSelect();
    }
  } catch {}
}

// ============================================================================
// 2. IndexedDB + Vercel Cloud (/api/projects & @vercel/blob) Persistence
// ============================================================================

function openStudioIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_VIDEOS)) {
        db.createObjectStore(STORE_VIDEOS, { keyPath: 'projectId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveProjectToIDB(
  record: SavedProjectSummary,
  videoBlob?: Blob | null
): Promise<void> {
  try {
    const db = await openStudioIDB();
    await new Promise<void>((res, rej) => {
      const tx = db.transaction([STORE_PROJECTS], 'readwrite');
      tx.objectStore(STORE_PROJECTS).put(record);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });

    if (videoBlob) {
      await new Promise<void>((res, rej) => {
        const tx = db.transaction([STORE_VIDEOS], 'readwrite');
        tx.objectStore(STORE_VIDEOS).put({
          projectId: record.id,
          blob: videoBlob,
          updatedAt: record.updatedAt,
        });
        tx.oncomplete = () => res();
        tx.onerror = () => rej(tx.error);
      });
    }
  } catch (e) {
    console.warn('IndexedDB save warning:', e);
  }
}

async function listProjectsFromIDB(): Promise<SavedProjectSummary[]> {
  try {
    const db = await openStudioIDB();
    return await new Promise<SavedProjectSummary[]>((res, rej) => {
      const tx = db.transaction([STORE_PROJECTS], 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).getAll();
      req.onsuccess = () => {
        const items = (req.result || []) as SavedProjectSummary[];
        items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
        res(items);
      };
      req.onerror = () => rej(req.error);
    });
  } catch {
    return [];
  }
}

async function getProjectFromIDB(projectId: string): Promise<{
  record: SavedProjectSummary | null;
  videoBlob: Blob | null;
}> {
  try {
    const db = await openStudioIDB();
    const record = await new Promise<SavedProjectSummary | null>((res) => {
      const tx = db.transaction([STORE_PROJECTS], 'readonly');
      const req = tx.objectStore(STORE_PROJECTS).get(projectId);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    });
    const videoEntry = await new Promise<{ projectId: string; blob: Blob } | null>((res) => {
      const tx = db.transaction([STORE_VIDEOS], 'readonly');
      const req = tx.objectStore(STORE_VIDEOS).get(projectId);
      req.onsuccess = () => res(req.result || null);
      req.onerror = () => res(null);
    });
    return { record, videoBlob: videoEntry?.blob || null };
  } catch {
    return { record: null, videoBlob: null };
  }
}

async function deleteProjectFromIDB(projectId: string): Promise<void> {
  try {
    const db = await openStudioIDB();
    await new Promise<void>((res) => {
      const tx = db.transaction([STORE_PROJECTS, STORE_VIDEOS], 'readwrite');
      tx.objectStore(STORE_PROJECTS).delete(projectId);
      tx.objectStore(STORE_VIDEOS).delete(projectId);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  } catch {}
}

/**
 * Uploads the source video Blob to Vercel Blob (`/api/upload-video`) if configured
 * and under the serverless payload threshold, returning the cloud URL.
 */
export async function tryUploadVideoToVercelBlob(
  fileName: string,
  videoBlob: Blob
): Promise<string | undefined> {
  try {
    // Only attempt direct serverless upload if <= 4.4 MB (Vercel Function payload limit)
    if (videoBlob.size > 4.4 * 1024 * 1024) return undefined;
    const resp = await fetch(`/api/upload-video?filename=${encodeURIComponent(fileName)}`, {
      method: 'POST',
      headers: { 'Content-Type': videoBlob.type || 'video/mp4' },
      body: videoBlob,
    });
    if (!resp.ok) return undefined;
    const data = await resp.json();
    return data?.ok && data?.blobUrl ? data.blobUrl : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves a project to both IndexedDB (with the full native video File/Blob) AND the Vercel `/api/projects` API.
 */
export async function saveStudioProject(params: {
  projectId: string;
  projectName: string;
  user: ComplexAuthUser;
  source: SourceVideoAsset;
  videoBlob?: Blob | null;
  fullVideoClip: GeneratedClip | null;
  generatedClips: GeneratedClip[];
  activeClipId: string | null;
  timelineMode: 'full-source' | 'elected-clip';
  activeScheme: EditingScheme;
  inMarker: number | null;
  outMarker: number | null;
  chatMessages: CopilotChatMessage[];
}): Promise<SavedProjectSummary> {
  const now = new Date().toISOString();
  const focusLocksCount = (
    params.fullVideoClip?.subjectFocus?.trackedPath ||
    params.generatedClips[0]?.subjectFocus?.trackedPath ||
    []
  ).filter((p) => p.isUserAnchor).length;

  const { url: _ignoreObjectUrl, ...serializableSource } = params.source;

  const projectState: ClipMakerProjectState = {
    sourceAsset: serializableSource,
    fullVideoClip: params.fullVideoClip,
    generatedClips: params.generatedClips,
    activeClipId: params.activeClipId,
    timelineMode: params.timelineMode,
    activeScheme: params.activeScheme,
    inMarker: params.inMarker,
    outMarker: params.outMarker,
    chatMessages: params.chatMessages,
  };

  const fullRecord: SavedProjectSummary = {
    id: params.projectId,
    name: params.projectName.trim() || params.source.name,
    ownerEmail: params.user.email,
    ownerName: params.user.name,
    updatedAt: now,
    createdAt: now,
    sourceFileName: params.source.name,
    sourceDuration: params.source.duration,
    clipsCount: params.generatedClips.length,
    focusLocksCount,
    storageLocation: 'local-indexeddb',
    projectState,
  };

  // 1. Save full project + video Blob to browser IndexedDB immediately
  await saveProjectToIDB(fullRecord, params.videoBlob);
  localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, params.projectId);

  // 2. Sync project manifest to Vercel (/api/projects -> Vercel Blob or server store)
  try {
    const resp = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: fullRecord }),
    });
    if (resp.ok) {
      const data = await resp.json();
      if (data?.ok) {
        fullRecord.storageLocation = 'vercel-cloud';
      }
    }
  } catch {}

  return fullRecord;
}

/**
 * Lists all saved projects (merging Vercel `/api/projects` and local IndexedDB).
 */
export async function listSavedStudioProjects(): Promise<SavedProjectSummary[]> {
  const localItems = await listProjectsFromIDB();
  const byId = new Map<string, SavedProjectSummary>();

  for (const item of localItems) {
    byId.set(item.id, { ...item, projectState: undefined });
  }

  try {
    const resp = await fetch('/api/projects');
    if (resp.ok) {
      const data = await resp.json();
      if (data?.ok && Array.isArray(data.projects)) {
        for (const remote of data.projects as SavedProjectSummary[]) {
          const existing = byId.get(remote.id);
          if (!existing || (remote.updatedAt || '') > (existing.updatedAt || '')) {
            byId.set(remote.id, {
              ...remote,
              storageLocation: 'vercel-cloud',
            });
          } else if (existing) {
            existing.storageLocation = 'vercel-cloud';
          }
        }
      }
    }
  } catch {}

  return Array.from(byId.values()).sort((a, b) =>
    (b.updatedAt || '').localeCompare(a.updatedAt || '')
  );
}

/**
 * Recalls a saved project by ID (restoring both the project state and the playable video URL/Blob).
 */
export async function recallStudioProject(projectId: string): Promise<{
  record: SavedProjectSummary;
  restoredVideoUrl: string | null;
  videoBlob: Blob | null;
} | null> {
  const local = await getProjectFromIDB(projectId);
  let record: SavedProjectSummary | null = local.record;

  if (!record || !record.projectState) {
    try {
      const resp = await fetch(`/api/projects?id=${encodeURIComponent(projectId)}`);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.ok && data.project) {
          record = data.project as SavedProjectSummary;
        }
      }
    } catch {}
  }

  if (!record || !record.projectState) return null;

  let restoredVideoUrl: string | null = null;
  if (local.videoBlob) {
    restoredVideoUrl = URL.createObjectURL(local.videoBlob);
  } else if (record.projectState.sourceAsset?.cloudVideoUrl) {
    restoredVideoUrl = record.projectState.sourceAsset.cloudVideoUrl;
  }

  localStorage.setItem(LAST_ACTIVE_PROJECT_KEY, projectId);
  return {
    record,
    restoredVideoUrl,
    videoBlob: local.videoBlob,
  };
}

export async function deleteStudioProject(projectId: string): Promise<void> {
  await deleteProjectFromIDB(projectId);
  if (localStorage.getItem(LAST_ACTIVE_PROJECT_KEY) === projectId) {
    localStorage.removeItem(LAST_ACTIVE_PROJECT_KEY);
  }
  try {
    await fetch(`/api/projects?id=${encodeURIComponent(projectId)}`, {
      method: 'DELETE',
    });
  } catch {}
}

export function getLastActiveProjectId(): string | null {
  return localStorage.getItem(LAST_ACTIVE_PROJECT_KEY);
}
