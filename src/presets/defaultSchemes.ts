import { EditingScheme, AIProviderSettings } from '../types/editor';

const SCHEMES_STORAGE_KEY = 'clipmaker_editing_schemes_v1';
const AI_SETTINGS_STORAGE_KEY = 'clipmaker_ai_provider_settings_v1';

export const DEFAULT_EDITING_SCHEMES: EditingScheme[] = [
  {
    id: 'scheme-viral-social',
    name: 'Viral Retention Hook (TikTok / Reels)',
    description:
      'High-retention 9:16 vertical scheme with rapid 1.8s hook cuts, dynamic 1.22x beat punch-ins, and responsive face/subject centering.',
    isBuiltIn: true,
    createdAt: '2026-10-29T12:00:00Z',
    targetClipDuration: 24,
    minClipDuration: 15,
    maxClipDuration: 35,
    maxClipsCount: 4,
    pacingProfile: 'fast-social',
    targetAvgShotLength: 2.1,
    audioPeakWeight: 0.78,
    visualMotionWeight: 0.65,
    silenceThresholdMs: 280,
    trackingMode: 'primary-subject',
    trackingSmoothing: 0.78,
    trackingDeadzone: 0.07,
    punchInZoom: 1.22,
    beatSyncCuts: true,
    captionStyle: 'hormozi-bold',
    safeZoneGuide: 'tiktok',
  },
  {
    id: 'scheme-podcast-speaker',
    name: 'Studio Podcast & Speaker Lock',
    description:
      'Tracks active speaker face with damped broadcast camera smoothing, strips conversational pauses >320ms, and adds clean Premiere minimal captions.',
    isBuiltIn: true,
    createdAt: '2026-10-29T12:05:00Z',
    targetClipDuration: 32,
    minClipDuration: 20,
    maxClipDuration: 55,
    maxClipsCount: 4,
    pacingProfile: 'balanced',
    targetAvgShotLength: 3.4,
    audioPeakWeight: 0.88,
    visualMotionWeight: 0.35,
    silenceThresholdMs: 320,
    trackingMode: 'face-speaker',
    trackingSmoothing: 0.89,
    trackingDeadzone: 0.11,
    punchInZoom: 1.14,
    beatSyncCuts: false,
    captionStyle: 'premiere-minimal',
    safeZoneGuide: 'reels',
  },
  {
    id: 'scheme-action-velocity',
    name: 'Action & Automotive Velocity 9:16',
    description:
      'Prioritizes high visual motion vectors and engine/beat transients with fast action tracking and tight deadzone to keep moving subjects dead-center.',
    isBuiltIn: true,
    createdAt: '2026-10-29T12:10:00Z',
    targetClipDuration: 18,
    minClipDuration: 10,
    maxClipDuration: 28,
    maxClipsCount: 5,
    pacingProfile: 'hyper-fast',
    targetAvgShotLength: 1.4,
    audioPeakWeight: 0.72,
    visualMotionWeight: 0.94,
    silenceThresholdMs: 220,
    trackingMode: 'action-motion',
    trackingSmoothing: 0.64,
    trackingDeadzone: 0.05,
    punchInZoom: 1.28,
    beatSyncCuts: true,
    captionStyle: 'neon-karaoke',
    safeZoneGuide: 'shorts',
  },
  {
    id: 'scheme-cinematic-summer',
    name: 'Cinematic Story & Travel Reel',
    description:
      'Smooth, floating 9:16 camera pans (94% spring damping) with breathing room for scenic shots and bold serif title overlays.',
    isBuiltIn: true,
    createdAt: '2026-10-29T12:15:00Z',
    targetClipDuration: 28,
    minClipDuration: 18,
    maxClipDuration: 45,
    maxClipsCount: 3,
    pacingProfile: 'cinematic',
    targetAvgShotLength: 4.5,
    audioPeakWeight: 0.55,
    visualMotionWeight: 0.7,
    silenceThresholdMs: 550,
    trackingMode: 'primary-subject',
    trackingSmoothing: 0.94,
    trackingDeadzone: 0.14,
    punchInZoom: 1.08,
    beatSyncCuts: true,
    captionStyle: 'cinema-serif',
    safeZoneGuide: 'reels',
  },
];

export function loadSavedSchemes(): EditingScheme[] {
  try {
    const raw = localStorage.getItem(SCHEMES_STORAGE_KEY);
    if (!raw) return DEFAULT_EDITING_SCHEMES;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
  } catch (e) {
    console.warn('Failed to load schemes from localStorage:', e);
  }
  return DEFAULT_EDITING_SCHEMES;
}

export function saveSchemesToStorage(schemes: EditingScheme[]): void {
  try {
    localStorage.setItem(SCHEMES_STORAGE_KEY, JSON.stringify(schemes));
  } catch (e) {
    console.warn('Failed to persist schemes to localStorage:', e);
  }
}

export const DEFAULT_AI_SETTINGS: AIProviderSettings = {
  activeProvider: 'gemini',
  models: {
    gemini: 'gemini-2.5-flash',
    claude: 'claude-3-7-sonnet-latest',
    openai: 'gpt-4o',
  },
  apiKeys: {
    gemini: '',
    claude: '',
    openai: '',
  },
  useVercelServerEnv: true,
};

export function loadAISettings(): AIProviderSettings {
  try {
    const raw = localStorage.getItem(AI_SETTINGS_STORAGE_KEY);
    if (!raw) return DEFAULT_AI_SETTINGS;
    return { ...DEFAULT_AI_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_AI_SETTINGS;
  }
}

export function saveAISettings(settings: AIProviderSettings): void {
  try {
    localStorage.setItem(AI_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.warn('Failed to save AI settings:', e);
  }
}
