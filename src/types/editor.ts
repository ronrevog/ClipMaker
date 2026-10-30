export type AIProviderId = 'gemini' | 'claude' | 'openai';

export interface AIProviderSettings {
  activeProvider: AIProviderId;
  models: {
    gemini: string;
    claude: string;
    openai: string;
  };
  apiKeys: {
    gemini: string;
    claude: string;
    openai: string;
  };
  useVercelServerEnv: boolean;
}

export type PacingProfile = 'hyper-fast' | 'fast-social' | 'balanced' | 'cinematic';
export type TrackingMode = 'face-speaker' | 'primary-subject' | 'action-motion' | 'center-lock';
export type CaptionStyleId = 'hormozi-bold' | 'premiere-minimal' | 'neon-karaoke' | 'cinema-serif';
export type SafeZoneGuideId = 'tiktok' | 'reels' | 'shorts' | 'none';
export type NLEToolId =
  | 'select'
  | 'track-select'
  | 'ripple'
  | 'razor'
  | 'slip'
  | 'hand'
  | 'reframe'
  | 'text';

export interface ReferenceTelemetrySummary {
  referenceFileName: string;
  durationSeconds: number;
  detectedCutCount: number;
  averageShotLength: number;
  cutsPerMinute: number;
  hookCutSpeedRatio: number;
  beatSyncRatio: number;
  estimatedZoomIntensity: number;
  motionEnergyScore: number;
  silenceRatio: number;
  aspectRatio: string;
  styleSummary?: string;
  extractedByProvider?: string;
}

export interface EditingScheme {
  id: string;
  name: string;
  description: string;
  isBuiltIn?: boolean;
  createdAt: string;
  targetClipDuration: number; // seconds, e.g. 25
  minClipDuration: number;
  maxClipDuration: number;
  maxClipsCount: number;
  pacingProfile: PacingProfile;
  targetAvgShotLength: number; // seconds per cut, e.g. 2.2
  audioPeakWeight: number; // 0..1
  visualMotionWeight: number; // 0..1
  silenceThresholdMs: number; // e.g. 300ms
  trackingMode: TrackingMode;
  trackingSmoothing: number; // 0.1 (snappy) .. 0.96 (cinematic damped)
  trackingDeadzone: number; // 0.02 .. 0.25 fraction of width
  punchInZoom: number; // 1.0 .. 1.4
  beatSyncCuts: boolean;
  captionStyle: CaptionStyleId;
  safeZoneGuide: SafeZoneGuideId;
  clonedFromReference?: ReferenceTelemetrySummary;
}

export interface TrackingSample {
  time: number; // seconds in source video
  rawX: number; // normalized 0..1 center in 16:9 frame
  rawY: number; // normalized 0..1 center in 16:9 frame
  cropX: number; // smoothed normalized 0..1 center for 9:16 window
  cropY: number;
  confidence: number; // 0..1
  subjectLabel: string;
  isManualKeyframe?: boolean;
}

export interface SubCut {
  id: string;
  index: number;
  sourceStart: number; // seconds in source video
  sourceEnd: number;
  timelineStart: number; // seconds in clip sequence
  timelineEnd: number;
  label: string;
  zoom: number; // 1.0 .. 1.5
  cropBiasX: number; // -0.35 .. +0.35 offset from tracked subject
  isBeatCut?: boolean;
}

export interface CaptionSegment {
  id: string;
  start: number; // clip timeline seconds
  end: number;
  text: string;
  highlightWord?: string;
}

export interface GeneratedClip {
  id: string;
  name: string;
  sourceVideoId: string;
  schemeId: string;
  schemeName: string;
  viralScore: number; // 0..99
  hookReason: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  trackingMode: TrackingMode;
  trackingOffsetX: number; // global horizontal offset -0.35..+0.35
  trackingSmoothing: number; // 0.1..0.96
  zoomScale: number; // base zoom 1.0..1.5
  captionText: string;
  captionStyle: CaptionStyleId;
  safeZoneGuide: SafeZoneGuideId;
  subCuts: SubCut[];
  captions: CaptionSegment[];
  manualKeyframes: Array<{ time: number; cropX: number; cropY: number }>;
}

export interface HighEnergyWindow {
  start: number;
  end: number;
  avgEnergy: number;
  peakCount: number;
}

export interface SourceVideoAsset {
  id: string;
  name: string;
  url: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  isSyntheticDemo?: boolean;
  waveformPeaks: number[]; // normalized 0..1 (e.g. 200 buckets)
  sceneCutTimestamps: number[];
  audioPeakTimestamps: number[];
  highEnergyWindows?: HighEnergyWindow[];
  sampledFrames?: Array<{ time: number; dataUrl: string }>;
  audioSampleBase64?: string;
  trackingSamples: TrackingSample[];
}

export interface ReferenceVideoAnalysis {
  id: string;
  fileName: string;
  videoUrl: string;
  telemetry: ReferenceTelemetrySummary;
  cutTimestamps: number[];
  keyframesBase64: string[];
  synthesizedScheme?: EditingScheme;
}

export interface CopilotRevisionSnapshot {
  id: string;
  timestamp: string;
  clipSnapshot: GeneratedClip;
  summaryBadges: string[];
}

export interface CopilotChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  clipId?: string;
  clipName?: string;
  playheadTime?: number;
  providerBadge?: string;
  liveApiUsed?: boolean;
  operationBadges?: string[];
  revisionSnapshotId?: string;
}
