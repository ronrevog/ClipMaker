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
export type ClipCreationMode = 'clip-segment' | 'condensed-edit';
export type TrackingMode = 'face-speaker' | 'primary-subject' | 'action-motion' | 'center-lock';

export type SubjectFocusStrategy =
  | 'auto-salient'
  | 'click-track'
  | 'static-lock'
  | 'face-speaker'
  | 'left-subject'
  | 'right-subject'
  | 'action-motion';

export interface ObjectTemplateSignature {
  patchSize: number; // e.g. 13 (13x13 spatial grid around clicked object)
  lumaPatch: number[]; // zero-mean unit-norm luminance template for ZNCC
  edgePatch: number[]; // unit-norm Sobel edge gradient template
  rgbPatch?: number[]; // flattened [r,g,b, r,g,b, ...] per-pixel color template (13x13x3)
  meanRgb: [number, number, number];
  contrastStd: number; // internal contrast standard deviation
  edgeEnergy?: number; // mean edge gradient energy of the clicked object
  detectedCategory?: string; // e.g. 'car', 'person', 'truck' from MediaPipe ObjectDetector
  boxW: number; // normalized width of tracked object (0.06..0.45)
  boxH: number; // normalized height of tracked object (0.06..0.45)
}

export interface TrackedObjectPoint {
  time: number;
  x: number;
  y: number;
  boxW?: number;
  boxH?: number;
  confidence?: number;
  isUserAnchor?: boolean;
}

export interface SubjectFocusConfig {
  strategy: SubjectFocusStrategy;
  anchorX: number; // 0..1 normalized horizontal target in source video
  anchorY: number; // 0..1 normalized vertical target in source video
  anchorTime: number; // source timestamp when picked
  targetColorRgb?: [number, number, number]; // sampled RGB signature of clicked subject
  templateSignature?: ObjectTemplateSignature; // 2D shape/edge/chroma template + neural category
  trackedPath?: TrackedObjectPoint[]; // solved multi-frame trajectory across the video
  label: string;
}

export type CaptionStyleId =
  | 'hormozi-bold'
  | 'premiere-minimal'
  | 'neon-karaoke'
  | 'cinema-serif'
  | 'street-graffiti';

export type CaptionFontFamilyId =
  | 'graffiti'
  | 'marker'
  | 'bangers'
  | 'impact'
  | 'bebas'
  | 'serif'
  | 'mono'
  | 'inter';

export interface VideoFilterConfig {
  brightness?: number; // 0.4 .. 2.0 (default 1.0)
  contrast?: number; // 0.4 .. 2.2 (default 1.0)
  saturation?: number; // 0.0 .. 2.5 (default 1.0)
  grayscale?: number; // 0.0 .. 1.0 (default 0.0)
  sepia?: number; // 0.0 .. 1.0 (default 0.0)
  hueRotate?: number; // -180 .. 180 deg (default 0)
}
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
  clipCreationMode?: ClipCreationMode;
  targetClipDuration: number;
  minClipDuration: number;
  maxClipDuration: number;
  maxClipsCount: number;
  pacingProfile: PacingProfile;
  targetAvgShotLength: number;
  audioPeakWeight: number;
  visualMotionWeight: number;
  silenceThresholdMs: number;
  trackingMode: TrackingMode;
  trackingSmoothing: number;
  trackingDeadzone: number;
  punchInZoom: number;
  beatSyncCuts: boolean;
  captionStyle: CaptionStyleId;
  safeZoneGuide: SafeZoneGuideId;
  clonedFromReference?: ReferenceTelemetrySummary;
}

export interface TrackingSample {
  time: number;
  rawX: number;
  rawY: number;
  cropX: number;
  cropY: number;
  leftSubjectX?: number;
  rightSubjectX?: number;
  faceX?: number;
  faceY?: number;
  motionX?: number;
  motionY?: number;
  motionScore?: number;
  objectBoxW?: number;
  objectBoxH?: number;
  confidence: number;
  subjectLabel: string;
  isManualKeyframe?: boolean;
}

export interface PerSecondTelemetry {
  time: number;
  audioEnergy: number;
  motionEnergy: number;
  viralScore: number;
  isSilent: boolean;
}

export type CutLayoutMode =
  | 'inherit'
  | 'split-screen'
  | 'full-single'
  | 'full-speaker-a'
  | 'full-speaker-b';

export interface SubCut {
  id: string;
  index: number;
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
  label: string;
  spokenQuote?: string;
  narrativeRole?: string;
  zoom: number;
  cropBiasX: number;
  isBeatCut?: boolean;
  speed?: number;
  layoutMode?: CutLayoutMode;
  isCompoundClip?: boolean;
  compoundSubCuts?: SubCut[];
}

export interface CaptionWordTiming {
  word: string;
  start: number;
  end: number;
}

export interface CaptionSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  highlightWord?: string;
  words?: CaptionWordTiming[];
}

export type BackgroundFillStyle = 'blurred' | 'black' | 'split-screen';

export type AudioMasteringPresetId =
  | 'off'
  | 'rnnoise-isolate'
  | 'podcast-clarity'
  | 'broadcast-lufs'
  | 'vocal-boost';
export type CutTransitionStyleId = 'none' | 'whip-pan' | 'zoom-punch' | 'flash-cut' | 'chromatic-glitch';
export type ColorGradeLutId = 'none' | 'cinematic-teal-orange' | 'warm-podcast' | 'crisp-contrast' | 'noir-bw';
export type LottieOverlayPresetId = 'none' | 'subscribe-pulse' | 'viral-flame' | 'live-badge' | 'arrow-pointer';

export interface VideoOverlayLayer {
  id: string;
  name: string;
  kind: 'text-banner' | 'call-to-action' | 'lower-third' | 'lottie-sticker';
  text: string;
  startTime: number;
  endTime: number;
  x: number;
  y: number;
  scale: number;
  rotation?: number;
  behindSubject?: boolean;
  lottiePreset?: LottieOverlayPresetId;
  bgColor: string;
  textColor: string;
  visible: boolean;
}

export interface GeneratedClip {
  id: string;
  name: string;
  sourceVideoId: string;
  schemeId: string;
  schemeName: string;
  clipCreationMode?: ClipCreationMode;
  viralScore: number;
  hookReason: string;
  commonThread?: string;
  viralMechanics?: string[];
  editorialReasoning?: string;
  sourceStart: number;
  sourceEnd: number;
  duration: number;
  trackingMode: TrackingMode;
  subjectFocus?: SubjectFocusConfig;
  trackingOffsetX: number;
  trackingSmoothing: number;
  zoomScale: number;
  backgroundFillStyle?: BackgroundFillStyle;
  speakerAX?: number; // Custom normalized 0..1 X center for Speaker A (default 0.26)
  speakerAY?: number; // Custom normalized 0..1 Y center for Speaker A (default 0.39 vertical / 0.44 horizontal)
  speakerAScale?: number; // Custom zoom/scale for Speaker A crop window (0.5 .. 2.5, default 1.0)
  speakerBX?: number; // Custom normalized 0..1 X center for Speaker B (default 0.74)
  speakerBY?: number; // Custom normalized 0..1 Y center for Speaker B (default 0.39 vertical / 0.44 horizontal)
  speakerBScale?: number; // Custom zoom/scale for Speaker B crop window (0.5 .. 2.5, default 1.0)
  splitScreenRatio?: number; // Top/Bottom panel split ratio (0.25 .. 0.75, default 0.5)
  playbackSpeed?: number;
  captionText: string;
  captionStyle: CaptionStyleId;
  captionFontFamily?: CaptionFontFamilyId;
  captionPositionY?: number; // 0.08 (top) .. 0.50 (middle) .. 0.78 (bottom)
  captionPositionX?: number; // 0.15 (left) .. 0.50 (center) .. 0.85 (right)
  captionFontScale?: number; // 0.5 .. 2.2 multiplier
  captionRotation?: number; // degrees (-45 .. 45)
  captionSpringPhysics?: boolean; // Spring pop-in animation on active spoken words
  captionTextColor?: string;
  captionHighlightColor?: string;
  captionBgColor?: string;
  captionBgOpacity?: number; // 0 (transparent) .. 1
  captionUppercase?: boolean;
  hideCaptions?: boolean;
  overlayBannerText?: string;
  overlayBannerPositionX?: number;
  overlayBannerPositionY?: number;
  overlayBannerScale?: number;
  overlayBannerRotation?: number;
  overlayBannerBehindSubject?: boolean; // MediaPipe SelfieSegmentation 3D behind-the-head text layer
  overlayBannerBgColor?: string;
  overlayBannerTextColor?: string;
  hideBannerLayer?: boolean;
  overlayLayers?: VideoOverlayLayer[];
  audioMasteringPreset?: AudioMasteringPresetId;
  transitionStyle?: CutTransitionStyleId;
  colorGradeLut?: ColorGradeLutId;
  videoFilter?: VideoFilterConfig;
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
  waveformPeaks: number[];
  sceneCutTimestamps: number[];
  audioPeakTimestamps: number[];
  highEnergyWindows?: HighEnergyWindow[];
  perSecondTelemetry?: PerSecondTelemetry[];
  sampledFrames?: Array<{ time: number; dataUrl: string }>;
  audioSampleBase64?: string;
  transcriptSegments?: CaptionSegment[];
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

export interface CopilotAttachment {
  id: string;
  name: string;
  mimeType: string;
  kind: 'image' | 'video' | 'text';
  dataUrl?: string; // Compact JPEG/PNG data URL for images or primary video thumbnail
  videoFramesDataUrls?: string[]; // Up to 4 sampled frames when a reference video is attached
  textContent?: string; // Extracted text for .txt, .srt, .md, .json, .csv files
  sizeBytes?: number;
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
  attachments?: CopilotAttachment[];
}
