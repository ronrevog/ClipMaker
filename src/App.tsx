import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import * as Tabs from '@radix-ui/react-tabs';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Bot,
  Check,
  ChevronDown,
  CornerDownLeft,
  Crosshair,
  Download,
  Eye,
  EyeOff,
  FileText,
  Film,
  Flame,
  FolderOpen,
  Image as ImageIcon,
  Info,
  Layers,
  Lock,
  LogOut,
  Maximize2,
  Mic,
  Move,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Sliders,
  Sparkles,
  Trash2,
  Type,
  Upload,
  UserCheck,
  Video,
  Volume2,
  VolumeX,
  Wand2,
  X,
  Zap,
} from 'lucide-react';
import {
  AIProviderId,
  AIProviderSettings,
  BackgroundFillStyle,
  ClipCreationMode,
  CopilotAttachment,
  CopilotChatMessage,
  CopilotRevisionSnapshot,
  EditingScheme,
  GeneratedClip,
  SourceVideoAsset,
  SubCut,
  SubjectFocusConfig,
  SubjectFocusStrategy,
  TrackedObjectPoint,
  VideoOverlayLayer,
} from './types/editor';
import {
  applyTwoSpeakerEditMode,
  buildWordLevelCaptionsFromText,
  ensureFullSourceTranscript,
  extractTimelineAudioWavBase64,
  renderComposite9x16Frame,
  snapCutsToAudioBeats,
  stripSilenceFromClip,
  transcribeClipAudioWithAI,
} from './services/aiVideoEditorTools';
import {
  loadAISettings,
  loadSavedSchemes,
  saveAISettings,
  saveSchemesToStorage,
} from './presets/defaultSchemes';
import { analyzeUploadedVideo } from './services/videoAnalyzer';
import {
  extractReferenceVideoTelemetry,
  synthesizeSchemeFromReference,
} from './services/referenceStyleCloner';
import {
  buildCondensedEditSubCuts,
  clipTimeToSourceTime,
  formatSMPTETimecode,
  generateClipsFromScheme,
  generateClipsWithMultimodalAI,
  recalculateClipTimeline,
  sourceTimeToClipTime,
} from './services/clipGenerator';
import {
  buildSmoothUserAnchorCurvePoints,
  captureClickedObjectSignature,
  computeDistortionFree9x16Crop,
  ensureNeuralObjectDetector,
  evaluateUserAnchorSplineAtTime,
  getTrackingStateAtTime,
  interpolateTrackedPathAtTime,
  resetLiveObjectTrackerState,
  solveClickedObjectTrajectory,
  trackSubjectSignatureInVideoFrame,
} from './services/subjectTracker';
import { exportClipTo9x16Video } from './services/videoExporter';
import { AISettingsModal } from './components/AISettingsModal';
import { ComplexAuthGate } from './components/ComplexAuthGate';
import { ProjectsModal } from './components/ProjectsModal';
import { TranscriptEditorModal } from './components/TranscriptEditorModal';
import {
  ComplexAuthUser,
  getLastActiveProjectId,
  loadSavedAuthUser,
  recallStudioProject,
  saveStudioProject,
  signOutComplexUser,
  tryUploadVideoToVercelBlob,
} from './services/projectStorage';

/**
 * Parses a user-entered duration string into seconds (clamped between 5 and 180 seconds / 3 mins).
 * Supports plain seconds ("45", "120s"), minutes ("2m", "2.5m"), or mm:ss ("1:30", "02:15", "3:00").
 */
function parseDurationTextToSeconds(raw: string, fallback: number): number {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return fallback;

  if (trimmed.includes(':')) {
    const parts = trimmed.split(':').map((p) => parseFloat(p));
    if (parts.length === 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
      const total = Math.round(parts[0] * 60 + parts[1]);
      return Math.max(5, Math.min(180, total));
    }
  }

  const minMatch = trimmed.match(/^(\d+(?:\.\d+)?)\s*m(?:in|ins|inutes)?$/);
  if (minMatch) {
    return Math.max(5, Math.min(180, Math.round(parseFloat(minMatch[1]) * 60)));
  }

  const num = parseFloat(trimmed.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(5, Math.min(180, Math.round(num)));
}

function formatDurationBadge(seconds: number): string {
  if (seconds >= 60) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }
  return `${seconds}s`;
}

function sanitizeCleanText(raw: string): string {
  return raw
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/\*\*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export const App: React.FC = () => {
  // 0. @complex.com Authentication & Shared Server Environment AI Status
  const [authUser, setAuthUser] = useState<ComplexAuthUser | null>(() => loadSavedAuthUser());
  const [serverAIStatus, setServerAIStatus] = useState<{
    geminiConfigured: boolean;
    claudeConfigured: boolean;
    openaiConfigured: boolean;
    googleClientId?: string;
    blobStorageConfigured?: boolean;
  }>({
    geminiConfigured: false,
    claudeConfigured: false,
    openaiConfigured: false,
    googleClientId: '',
    blobStorageConfigured: false,
  });

  // Project Persistence & Recall States
  const [currentProjectId, setCurrentProjectId] = useState<string>(
    () => getLastActiveProjectId() || `proj-${Date.now()}`
  );
  const [currentProjectName, setCurrentProjectName] = useState<string>('Untitled Project');
  const [isProjectsModalOpen, setIsProjectsModalOpen] = useState<boolean>(false);
  const [isSavingProject, setIsSavingProject] = useState<boolean>(false);
  const uploadedVideoBlobRef = useRef<Blob | null>(null);

  useEffect(() => {
    fetch('/api/ai-status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) setServerAIStatus(data);
      })
      .catch(() => {});
  }, []);

  // 1. Editing Schemes & AI Settings (Gemini Default, Claude, OpenAI)
  const [schemes, setSchemes] = useState<EditingScheme[]>(() => loadSavedSchemes());
  const [activeScheme, setActiveScheme] = useState<EditingScheme>(() => loadSavedSchemes()[0]);
  const [aiSettings, setAiSettings] = useState<AIProviderSettings>(() => loadAISettings());
  const [isAISettingsOpen, setIsAISettingsOpen] = useState(false);
  const [isTranscriptEditorOpen, setIsTranscriptEditorOpen] = useState(false);
  const [schemeSavedNotice, setSchemeSavedNotice] = useState<string | null>(null);

  // Text input draft states so user can freely type clip duration (up to 180s / 3m), clip count, and ASL
  const [durationTextInput, setDurationTextInput] = useState<string>(() =>
    String(loadSavedSchemes()[0]?.targetClipDuration || 24)
  );
  const [clipsCountTextInput, setClipsCountTextInput] = useState<string>(() =>
    String(loadSavedSchemes()[0]?.maxClipsCount || 4)
  );
  const [aslTextInput, setAslTextInput] = useState<string>(() =>
    String(loadSavedSchemes()[0]?.targetAvgShotLength || 2.2)
  );

  useEffect(() => {
    setDurationTextInput(String(activeScheme.targetClipDuration));
    setClipsCountTextInput(String(activeScheme.maxClipsCount));
    setAslTextInput(String(activeScheme.targetAvgShotLength));
  }, [
    activeScheme.id,
    activeScheme.targetClipDuration,
    activeScheme.maxClipsCount,
    activeScheme.targetAvgShotLength,
  ]);

  // 2. Uploaded Source Video, Editable Full Video Sequence, Timeline Mode & Generated 9:16 Clips
  const [activeSource, setActiveSource] = useState<SourceVideoAsset | null>(null);
  const [fullVideoClip, setFullVideoClip] = useState<GeneratedClip | null>(null);
  const [timelineMode, setTimelineMode] = useState<'full-source' | 'elected-clip'>('full-source');
  const [generatedClips, setGeneratedClips] = useState<GeneratedClip[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);
  const [selectedCutIndex, setSelectedCutIndex] = useState<number>(0);

  // 3. Subject Focus & Click-to-Track State (keeps chosen subject locked in the center of 9:16!)
  const [clickPickMode, setClickPickMode] = useState<'track' | 'static'>('track');
  const [applyFocusToAllClips, setApplyFocusToAllClips] = useState<boolean>(true);
  const [liveTrackedAnchor, setLiveTrackedAnchor] = useState<{ x: number; y: number } | null>(
    null
  );
  const liveTrackedAnchorRef = useRef<{ x: number; y: number } | null>(null);
  const userFocusAnchorsRef = useRef<TrackedObjectPoint[]>([]);
  const [isSolvingObjectTrack, setIsSolvingObjectTrack] = useState<boolean>(false);
  const [objectTrackProgress, setObjectTrackProgress] = useState<number>(0);

  // Warm up MediaPipe Neural ObjectDetector in the background on mount
  useEffect(() => {
    ensureNeuralObjectDetector().catch(() => {});
  }, []);

  // 4. Razor Blade Tool & In/Out Markers State
  const [isRazorMode, setIsRazorMode] = useState<boolean>(false);
  const [razorHoverClipTime, setRazorHoverClipTime] = useState<number | null>(null);
  const [inMarker, setInMarker] = useState<number | null>(null); // seconds in source video
  const [outMarker, setOutMarker] = useState<number | null>(null); // seconds in source video
  const [isLoopingInOut, setIsLoopingInOut] = useState<boolean>(false);
  const [markerNotice, setMarkerNotice] = useState<string | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<'playhead' | 'in' | 'out' | null>(null);

  const selectedClipObj =
    generatedClips.find((c) => c.id === activeClipId) || generatedClips[0] || null;

  const activeClip: GeneratedClip | null =
    timelineMode === 'full-source' ? fullVideoClip : selectedClipObj;

  // Sync liveTrackedAnchor when switching clips or when subjectFocus changes
  useEffect(() => {
    if (activeClip?.subjectFocus) {
      const pt = {
        x: activeClip.subjectFocus.anchorX,
        y: activeClip.subjectFocus.anchorY,
      };
      liveTrackedAnchorRef.current = pt;
      setLiveTrackedAnchor(pt);
    } else {
      liveTrackedAnchorRef.current = null;
      setLiveTrackedAnchor(null);
    }
  }, [
    activeClip?.id,
    activeClip?.subjectFocus?.strategy,
    activeClip?.subjectFocus?.anchorX,
    activeClip?.subjectFocus?.anchorY,
  ]);

  // 5. Native Video Element & Playback State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preview9x16CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceOverlayWrapRef = useRef<HTMLDivElement | null>(null);
  const timelineBarRef = useRef<HTMLDivElement | null>(null);
  const activeCutIdxRef = useRef<number>(0);

  const [nativeDims, setNativeDims] = useState<{ width: number; height: number }>({
    width: 1920,
    height: 1080,
  });
  const [playheadTime, setPlayheadTime] = useState<number>(0); // seconds in source video
  const [clipPlayheadTime, setClipPlayheadTime] = useState<number>(0); // seconds in current timeline (0 .. activeClip.duration)
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isDraggingCrop, setIsDraggingCrop] = useState<boolean>(false);
  const [draggingSpeaker, setDraggingSpeaker] = useState<'A' | 'B' | null>(null);
  const [scalingSpeaker, setScalingSpeaker] = useState<'A' | 'B' | null>(null);
  const [selectedSpeakerTarget, setSelectedSpeakerTarget] = useState<'A' | 'B'>('A');

  // Resizable Workspace Panel Windows & Multi-Track NLE Layer State
  const [leftPanelWidth, setLeftPanelWidth] = useState<number>(300);
  const [rightPanelWidth, setRightPanelWidth] = useState<number>(315);
  const [timelineHeight, setTimelineHeight] = useState<number>(265);
  const [monitorSplitRatio, setMonitorSplitRatio] = useState<number>(0.5);
  const [resizingPane, setResizingPane] = useState<'left' | 'right' | 'timeline' | 'monitors' | null>(null);
  const dualMonitorStageRef = useRef<HTMLDivElement | null>(null);
  const [selectedLayerTrack, setSelectedLayerTrack] = useState<
    'v4-overlay' | 'v3-captions' | 'v2-speaker' | 'v1-video' | 'a1-audio'
  >('v1-video');
  const [selectedOverlayLayerId, setSelectedOverlayLayerId] = useState<string | null>(null);
  const [selectedCaptionId, setSelectedCaptionId] = useState<string | null>(null);
  const [draggingOutputLayer, setDraggingOutputLayer] = useState<
    'captions' | 'banner' | 'split-divider' | string | null
  >(null);
  const [scalingOutputLayer, setScalingOutputLayer] = useState<
    'captions' | 'banner' | string | null
  >(null);
  const outputOverlayWrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!resizingPane) return;
    const onMove = (e: MouseEvent) => {
      if (resizingPane === 'left') {
        setLeftPanelWidth(Math.max(220, Math.min(540, e.clientX)));
      } else if (resizingPane === 'right') {
        setRightPanelWidth(Math.max(240, Math.min(560, window.innerWidth - e.clientX)));
      } else if (resizingPane === 'timeline') {
        setTimelineHeight(Math.max(175, Math.min(520, window.innerHeight - e.clientY)));
      } else if (resizingPane === 'monitors' && dualMonitorStageRef.current) {
        const rect = dualMonitorStageRef.current.getBoundingClientRect();
        if (rect.width > 100) {
          const ratio = (e.clientX - rect.left) / rect.width;
          setMonitorSplitRatio(Math.max(0.28, Math.min(0.72, ratio)));
        }
      }
    };
    const onUp = () => setResizingPane(null);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingPane]);

  // 6. Progress & Busy States
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisStatus, setAnalysisStatus] = useState<string>('');
  const [isCloningRef, setIsCloningRef] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [isTranscribingAudio, setIsTranscribingAudio] = useState<boolean>(false);
  const [transcriptionProgress, setTranscriptionProgress] = useState<number>(0);
  const [isGeneratingClips, setIsGeneratingClips] = useState<boolean>(false);
  const [clipGenerationStage, setClipGenerationStage] = useState<string>('');
  const [clipGenerationProgress, setClipGenerationProgress] = useState<number>(0);
  const [editorialFocusInput, setEditorialFocusInput] = useState<string>('');

  // 7. Cut Copilot Chat State
  const [chatInput, setChatInput] = useState<string>('');
  const [pendingChatAttachments, setPendingChatAttachments] = useState<CopilotAttachment[]>([]);
  const [isDraggingChatFile, setIsDraggingChatFile] = useState<boolean>(false);
  const [isCopilotBusy, setIsCopilotBusy] = useState<boolean>(false);
  const [revisions, setRevisions] = useState<CopilotRevisionSnapshot[]>([]);
  const [chatMessages, setChatMessages] = useState<CopilotChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: 'Ready.',
      timestamp: new Date().toISOString(),
      providerBadge: 'gemini-4-argon',
    },
  ]);

  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const referenceFileInputRef = useRef<HTMLInputElement | null>(null);
  const chatAttachmentInputRef = useRef<HTMLInputElement | null>(null);

  // Helper to build a fresh unedited Full Video clip object
  const createInitialFullVideoClip = useCallback(
    (source: SourceVideoAsset, scheme: EditingScheme): GeneratedClip => ({
      id: '__full_source__',
      name: `Full Video — ${source.name}`,
      sourceVideoId: source.id,
      schemeId: scheme.id,
      schemeName: scheme.name,
      clipCreationMode: 'clip-segment',
      viralScore: 100,
      hookReason: 'Full uploaded video sequence on timeline',
      sourceStart: 0,
      sourceEnd: source.duration,
      duration: source.duration,
      trackingMode: scheme.trackingMode,
      trackingOffsetX: 0,
      trackingSmoothing: scheme.trackingSmoothing,
      zoomScale: 1.0,
      captionText: '',
      captionStyle: scheme.captionStyle,
      safeZoneGuide: scheme.safeZoneGuide,
      subCuts: [
        {
          id: `full-cut-1-${Date.now()}`,
          index: 1,
          sourceStart: 0,
          sourceEnd: source.duration,
          timelineStart: 0,
          timelineEnd: source.duration,
          label: 'Full Video',
          zoom: 1.0,
          cropBiasX: 0,
        },
      ],
      captions: [],
      manualKeyframes: [],
    }),
    []
  );

  // Determine active sub-cut from clipPlayheadTime
  const mappedAtPlayhead = activeClip
    ? clipTimeToSourceTime(activeClip, clipPlayheadTime)
    : { sourceTime: playheadTime, activeCut: undefined, cutIndex: 0 };

  const activeCut =
    mappedAtPlayhead.activeCut ||
    activeClip?.subCuts.find(
      (c) => playheadTime >= c.sourceStart - 0.05 && playheadTime <= c.sourceEnd + 0.05
    ) ||
    activeClip?.subCuts[0];

  const currentZoom = activeCut ? activeCut.zoom : activeClip?.zoomScale ?? 1.0;
  const currentCutBias = activeCut ? activeCut.cropBiasX : 0;

  // Extract sorted user Focus Lock Points along the timeline
  const userFocusAnchors = React.useMemo(() => {
    const path = activeClip?.subjectFocus?.trackedPath;
    if (!path || path.length === 0) return [];
    return path
      .filter((pt) => pt.isUserAnchor)
      .slice()
      .sort((a, b) => a.time - b.time);
  }, [activeClip?.subjectFocus?.trackedPath]);

  const activeUserSplinePoint = React.useMemo(
    () => evaluateUserAnchorSplineAtTime(activeClip?.subjectFocus?.trackedPath, playheadTime),
    [activeClip?.subjectFocus?.trackedPath, playheadTime]
  );

  // Build effective SubjectFocusConfig with real-time tracked coordinates when 'click-track' is active.
  // When 2+ user Focus Lock Points span the current playheadTime, the smooth spline between them takes priority!
  const effectiveSubjectFocus: SubjectFocusConfig | undefined = activeClip?.subjectFocus
    ? {
        ...activeClip.subjectFocus,
        anchorX:
          activeClip.subjectFocus.strategy === 'click-track' && activeUserSplinePoint
            ? activeUserSplinePoint.x
            : activeClip.subjectFocus.strategy === 'click-track' && liveTrackedAnchor
              ? liveTrackedAnchor.x
              : activeClip.subjectFocus.anchorX,
        anchorY:
          activeClip.subjectFocus.strategy === 'click-track' && activeUserSplinePoint
            ? activeUserSplinePoint.y
            : activeClip.subjectFocus.strategy === 'click-track' && liveTrackedAnchor
              ? liveTrackedAnchor.y
              : activeClip.subjectFocus.anchorY,
        trackedPath:
          activeClip.subjectFocus.strategy === 'click-track' &&
          liveTrackedAnchor &&
          !activeUserSplinePoint
            ? undefined
            : activeClip.subjectFocus.trackedPath,
      }
    : undefined;

  const currentTrack = getTrackingStateAtTime(
    activeSource?.trackingSamples || [],
    playheadTime,
    (activeClip?.trackingOffsetX ?? 0) + currentCutBias,
    activeClip?.manualKeyframes ?? [],
    effectiveSubjectFocus
  );

  const currentCrop = computeDistortionFree9x16Crop(
    nativeDims.width,
    nativeDims.height,
    currentTrack.cropX,
    currentTrack.cropY,
    currentZoom
  );

  // Render the distortion-free 9:16 Output Canvas from the native <video> element
  const render9x16Preview = useCallback(() => {
    const canvas = preview9x16CanvasRef.current;
    const vid = videoRef.current;
    if (!canvas || !vid || vid.readyState < 2) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const outW = canvas.width;
    const outH = canvas.height;
    const vw = vid.videoWidth || nativeDims.width;
    const vh = vid.videoHeight || nativeDims.height;

    renderComposite9x16Frame({
      ctx,
      videoEl: vid,
      outW,
      outH,
      vw,
      vh,
      cropX: currentTrack.cropX,
      cropY: currentTrack.cropY,
      leftSubjectX: currentTrack.leftSubjectX,
      rightSubjectX: currentTrack.rightSubjectX,
      zoom: currentZoom,
      backgroundFillStyle: activeClip?.backgroundFillStyle ?? 'blurred',
      activeClip,
      clipPlayheadTime,
    });
  }, [
    nativeDims,
    currentTrack.cropX,
    currentTrack.cropY,
    currentTrack.leftSubjectX,
    currentTrack.rightSubjectX,
    currentZoom,
    activeClip,
    clipPlayheadTime,
  ]);

  useEffect(() => {
    if (videoRef.current) {
      const targetRate = activeClip?.playbackSpeed ?? 1.0;
      if (Math.abs(videoRef.current.playbackRate - targetRate) > 0.01) {
        videoRef.current.playbackRate = targetRate;
      }
    }
  }, [activeClip?.playbackSpeed, activeClip?.id]);

  useEffect(() => {
    render9x16Preview();
    if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
      (document as any).fonts.ready.then(() => {
        render9x16Preview();
      });
    }
  }, [
    render9x16Preview,
    playheadTime,
    clipPlayheadTime,
    liveTrackedAnchor,
    activeClip?.backgroundFillStyle,
    activeClip?.speakerAX,
    activeClip?.speakerAY,
    activeClip?.speakerAScale,
    activeClip?.speakerBX,
    activeClip?.speakerBY,
    activeClip?.speakerBScale,
    activeClip?.splitScreenRatio,
    activeClip?.subCuts,
    activeClip?.zoomScale,
    activeClip?.trackingOffsetX,
    activeClip?.subjectFocus,
    activeClip?.captions,
    activeClip?.captionText,
    activeClip?.captionFontFamily,
    activeClip?.captionStyle,
    activeClip?.captionPositionY,
    activeClip?.captionPositionX,
    activeClip?.captionFontScale,
    activeClip?.captionTextColor,
    activeClip?.captionHighlightColor,
    activeClip?.captionBgOpacity,
    activeClip?.hideCaptions,
    activeClip?.overlayBannerText,
    activeClip?.overlayBannerPositionX,
    activeClip?.overlayBannerPositionY,
    activeClip?.overlayBannerScale,
    activeClip?.hideBannerLayer,
    activeClip?.overlayLayers,
    activeClip?.videoFilter,
  ]);

  // Seek to a specific time on the active timeline (0 .. activeClip.duration)
  const handleSeekClipTime = useCallback(
    (targetClipTime: number) => {
      if (!activeSource || !activeClip) return;
      const clampedClipTime = Math.max(0, Math.min(activeClip.duration, targetClipTime));
      const { sourceTime, cutIndex } = clipTimeToSourceTime(activeClip, clampedClipTime);
      if (cutIndex >= 0) {
        activeCutIdxRef.current = cutIndex;
        setSelectedCutIndex(cutIndex);
      }
      setClipPlayheadTime(clampedClipTime);
      setPlayheadTime(sourceTime);
      if (videoRef.current) {
        videoRef.current.currentTime = sourceTime;
      }
    },
    [activeSource, activeClip]
  );

  // Seek to a specific source video time (and sync clipPlayheadTime)
  const handleSeekSourceTime = useCallback(
    (sourceTime: number, clipOverride?: GeneratedClip) => {
      if (!activeSource) return;
      const targetClip = clipOverride ?? activeClip;
      const clampedSource = Math.max(0, Math.min(activeSource.duration, sourceTime));
      setPlayheadTime(clampedSource);
      if (targetClip) {
        const cTime = sourceTimeToClipTime(targetClip, clampedSource);
        setClipPlayheadTime(cTime);
        const foundIdx = targetClip.subCuts.findIndex(
          (c) => clampedSource >= c.sourceStart - 0.05 && clampedSource <= c.sourceEnd + 0.05
        );
        if (foundIdx >= 0) {
          activeCutIdxRef.current = foundIdx;
          setSelectedCutIndex(foundIdx);
        }
      }
      if (videoRef.current) {
        videoRef.current.currentTime = clampedSource;
      }
    },
    [activeSource, activeClip]
  );

  // Verify & snap the tracked object position directly on the live visible <video> frame
  const syncLiveObjectLockOnCurrentFrame = useCallback(() => {
    const vid = videoRef.current;
    if (!vid || vid.readyState < 2 || !activeClip?.subjectFocus) return;
    if (activeClip.subjectFocus.strategy !== 'click-track') return;

    const pathHint = interpolateTrackedPathAtTime(
      activeClip.subjectFocus.trackedPath,
      vid.currentTime
    );
    const prevPt = liveTrackedAnchorRef.current ||
      pathHint || {
        x: activeClip.subjectFocus.anchorX,
        y: activeClip.subjectFocus.anchorY,
      };

    const nextPt = trackSubjectSignatureInVideoFrame(
      vid,
      prevPt.x,
      prevPt.y,
      activeClip.subjectFocus.targetColorRgb,
      activeClip.subjectFocus.templateSignature,
      activeClip.subjectFocus.trackedPath
    );
    liveTrackedAnchorRef.current = nextPt;
    setLiveTrackedAnchor(nextPt);
  }, [activeClip]);

  // Run live frame object snap whenever paused frame / playhead changes
  useEffect(() => {
    if (!isPlaying && activeClip?.subjectFocus?.strategy === 'click-track') {
      syncLiveObjectLockOnCurrentFrame();
    }
  }, [
    isPlaying,
    playheadTime,
    activeClip?.subjectFocus?.strategy,
    activeClip?.subjectFocus?.anchorTime,
    syncLiveObjectLockOnCurrentFrame,
  ]);

  // 60fps synchronization + live Subject Tracking loop while playing
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const vid = videoRef.current;
      if (vid && activeSource && activeClip) {
        // Always run real-time visual + neural + rigid-object tracker on the live <video> element during playback!
        if (activeClip.subjectFocus?.strategy === 'click-track') {
          const prevPt = liveTrackedAnchorRef.current || {
            x: activeClip.subjectFocus.anchorX,
            y: activeClip.subjectFocus.anchorY,
          };
          const nextPt = trackSubjectSignatureInVideoFrame(
            vid,
            prevPt.x,
            prevPt.y,
            activeClip.subjectFocus.targetColorRgb,
            activeClip.subjectFocus.templateSignature,
            activeClip.subjectFocus.trackedPath
          );
          liveTrackedAnchorRef.current = nextPt;
          setLiveTrackedAnchor(nextPt);
        }

        if (
          isLoopingInOut &&
          inMarker !== null &&
          outMarker !== null &&
          outMarker > inMarker + 0.2
        ) {
          if (vid.currentTime >= outMarker || vid.ended || vid.currentTime < inMarker - 0.1) {
            vid.currentTime = inMarker;
            if (vid.paused) vid.play().catch(() => {});
          }
          setPlayheadTime(vid.currentTime);
          setClipPlayheadTime(sourceTimeToClipTime(activeClip, vid.currentTime));
          render9x16Preview();
          rafId = requestAnimationFrame(tick);
          return;
        }

        const cuts = activeClip.subCuts;
        if (cuts && cuts.length > 0) {
          let idx = activeCutIdxRef.current;
          if (idx < 0 || idx >= cuts.length) idx = 0;
          const currentCut = cuts[idx];

          if (vid.currentTime >= currentCut.sourceEnd - 0.03 || vid.ended) {
            const nextIdx = idx + 1;
            if (nextIdx < cuts.length) {
              activeCutIdxRef.current = nextIdx;
              setSelectedCutIndex(nextIdx);
              const nextCut = cuts[nextIdx];
              if (Math.abs(vid.currentTime - nextCut.sourceStart) > 0.08) {
                vid.currentTime = nextCut.sourceStart;
              }
              setPlayheadTime(nextCut.sourceStart);
              setClipPlayheadTime(nextCut.timelineStart);
              if (vid.paused) vid.play().catch(() => {});
            } else {
              activeCutIdxRef.current = 0;
              setSelectedCutIndex(0);
              const firstCut = cuts[0];
              vid.currentTime = firstCut.sourceStart;
              setPlayheadTime(firstCut.sourceStart);
              setClipPlayheadTime(0);
              if (vid.paused) vid.play().catch(() => {});
            }
          } else {
            const offsetInCut = Math.max(0, vid.currentTime - currentCut.sourceStart);
            const cTime = Math.min(
              activeClip.duration,
              currentCut.timelineStart + offsetInCut
            );
            setPlayheadTime(vid.currentTime);
            setClipPlayheadTime(cTime);
          }
        } else {
          if (vid.currentTime >= activeClip.sourceEnd || vid.ended) {
            vid.currentTime = activeClip.sourceStart;
            if (vid.paused) vid.play().catch(() => {});
          }
          setPlayheadTime(vid.currentTime);
          setClipPlayheadTime(Math.max(0, vid.currentTime - activeClip.sourceStart));
        }
        render9x16Preview();
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, isLoopingInOut, inMarker, outMarker, activeSource, activeClip, render9x16Preview]);

  // Play / Pause helper
  const handleTogglePlay = useCallback(
    async (loopInOutMode = false) => {
      const vid = videoRef.current;
      if (!vid || !activeSource || !activeClip) return;
      if (isPlaying && isLoopingInOut === loopInOutMode) {
        vid.pause();
        setIsPlaying(false);
        setIsLoopingInOut(false);
      } else {
        setIsLoopingInOut(loopInOutMode);
        if (loopInOutMode && inMarker !== null && outMarker !== null && outMarker > inMarker) {
          vid.currentTime = inMarker;
          setPlayheadTime(inMarker);
          setClipPlayheadTime(sourceTimeToClipTime(activeClip, inMarker));
        } else {
          const cuts = activeClip.subCuts;
          if (cuts && cuts.length > 0) {
            if (clipPlayheadTime >= activeClip.duration - 0.1) {
              activeCutIdxRef.current = 0;
              setSelectedCutIndex(0);
              setClipPlayheadTime(0);
              setPlayheadTime(cuts[0].sourceStart);
              vid.currentTime = cuts[0].sourceStart;
            } else {
              const { sourceTime, cutIndex } = clipTimeToSourceTime(activeClip, clipPlayheadTime);
              activeCutIdxRef.current = Math.max(0, cutIndex);
              if (Math.abs(vid.currentTime - sourceTime) > 0.15) {
                vid.currentTime = sourceTime;
              }
            }
          }
        }
        try {
          vid.muted = isMuted;
          await vid.play();
          setIsPlaying(true);
        } catch (e) {
          console.warn('Playback failed:', e);
          setIsPlaying(false);
        }
      }
    },
    [
      activeSource,
      isPlaying,
      isLoopingInOut,
      inMarker,
      outMarker,
      activeClip,
      clipPlayheadTime,
      isMuted,
    ]
  );

  // Universal updater that modifies either the active GeneratedClip OR the editable Full Video sequence
  const updateActiveTimelineClip = useCallback(
    (updater: (clip: GeneratedClip) => GeneratedClip) => {
      if (timelineMode === 'full-source') {
        setFullVideoClip((prev) => (prev ? updater(prev) : prev));
      } else if (selectedClipObj) {
        setGeneratedClips((prev) =>
          prev.map((c) => (c.id === selectedClipObj.id ? updater(c) : c))
        );
      }
    },
    [timelineMode, selectedClipObj]
  );

  // Apply a target zoom level across every sub-cut on the timeline (and optionally all generated clips + scheme)
  const applyZoomAcrossStudio = useCallback(
    (rawZoom: number, applyToAllClips = true) => {
      const z = Number(Math.max(0.55, Math.min(1.5, rawZoom || 1.0)).toFixed(2));
      const setAllCutsZoom = (clip: GeneratedClip): GeneratedClip => ({
        ...clip,
        zoomScale: z,
        subCuts: clip.subCuts.map((cut) => ({ ...cut, zoom: z })),
      });

      setFullVideoClip((prev) => (prev ? setAllCutsZoom(prev) : prev));
      if (applyToAllClips) {
        setGeneratedClips((prev) => prev.map((c) => setAllCutsZoom(c)));
        setActiveScheme((prev) => ({
          ...prev,
          punchInZoom: Math.max(1.0, z),
        }));
      } else if (selectedClipObj) {
        setGeneratedClips((prev) =>
          prev.map((c) => (c.id === selectedClipObj.id ? setAllCutsZoom(c) : c))
        );
      }
    },
    [selectedClipObj]
  );

  // Apply a SubjectFocusConfig to the active clip (and optionally all generated clips so the user doesn't have to re-pick!)
  const applySubjectFocusConfig = useCallback(
    (focusConfig: SubjectFocusConfig, resetLiveAnchor = true) => {
      if (resetLiveAnchor) {
        const pt = { x: focusConfig.anchorX, y: focusConfig.anchorY };
        liveTrackedAnchorRef.current = pt;
        setLiveTrackedAnchor(pt);
      }

      if (applyFocusToAllClips) {
        setFullVideoClip((prev) =>
          prev
            ? {
                ...prev,
                subjectFocus: focusConfig,
                trackingOffsetX: 0,
                manualKeyframes: [],
              }
            : prev
        );
        setGeneratedClips((prev) =>
          prev.map((c) => ({
            ...c,
            subjectFocus: focusConfig,
            trackingOffsetX: 0,
            manualKeyframes: [],
          }))
        );
      } else {
        updateActiveTimelineClip((c) => ({
          ...c,
          subjectFocus: focusConfig,
          trackingOffsetX: 0,
          manualKeyframes: [],
        }));
      }
    },
    [applyFocusToAllClips, updateActiveTimelineClip]
  );

  // Quick Subject Focus Preset Selector (Auto Face/Speaker, Left Subject, Center, Right Subject, Action Motion)
  const handleSelectSubjectFocusStrategy = useCallback(
    (strategy: SubjectFocusStrategy) => {
      const isVerticalSource = nativeDims.width < nativeDims.height;
      let anchorX = 0.5;
      let anchorY = isVerticalSource ? 0.41 : 0.48;
      let label = 'Auto Salient Subject';

      if (strategy === 'left-subject') {
        anchorX = 0.26;
        anchorY = isVerticalSource ? 0.41 : 0.46;
        label = 'Left Speaker Focus';
      } else if (strategy === 'right-subject') {
        anchorX = 0.74;
        anchorY = isVerticalSource ? 0.41 : 0.46;
        label = 'Right Speaker Focus';
      } else if (strategy === 'face-speaker') {
        anchorX = currentTrack.faceX ?? currentTrack.cropX;
        anchorY = currentTrack.faceY ?? 0.42;
        label = 'Auto Face / Speaker';
      } else if (strategy === 'action-motion') {
        anchorX = currentTrack.motionX ?? currentTrack.cropX;
        anchorY = currentTrack.motionY ?? 0.5;
        label = 'Action / Motion Focus';
      } else if (strategy === 'static-lock') {
        anchorX = 0.5;
        anchorY = 0.5;
        label = 'Center 9:16 Lock';
      }

      if (strategy !== 'click-track') {
        userFocusAnchorsRef.current = [];
        liveTrackedAnchorRef.current = null;
      }

      applySubjectFocusConfig({
        strategy,
        anchorX,
        anchorY,
        anchorTime: playheadTime,
        label,
      });

      // On vertical 2-speaker videos (e.g. 720x1280), isolating Left Speaker or Right Speaker requires ~1.85x zoom
      if (isVerticalSource && (strategy === 'left-subject' || strategy === 'right-subject')) {
        const speakerZoom = Math.max(1.85, currentZoom);
        updateActiveTimelineClip((c) => ({
          ...c,
          backgroundFillStyle: c.backgroundFillStyle === 'split-screen' ? 'blurred' : c.backgroundFillStyle,
          zoomScale: speakerZoom,
          subCuts: c.subCuts.map((sc) => ({
            ...sc,
            zoom: speakerZoom,
            cropBiasX: strategy === 'left-subject' ? -0.24 : 0.24,
          })),
        }));
      } else {
        updateActiveTimelineClip((c) => ({
          ...c,
          backgroundFillStyle: c.backgroundFillStyle === 'split-screen' ? 'blurred' : c.backgroundFillStyle,
          subCuts: c.subCuts.map((sc) => ({
            ...sc,
            cropBiasX: 0,
          })),
        }));
      }

      setMarkerNotice(`9:16 Subject Focus set to: ${label}`);
      setTimeout(() => setMarkerNotice(null), 2400);
    },
    [currentTrack, playheadTime, applySubjectFocusConfig, nativeDims, currentZoom, updateActiveTimelineClip]
  );

  // Dedicated 2-Speaker Podcast Director (Split-Screen OR Auto-Switch Speaker Cuts)
  const handleTwoSpeakerMode = useCallback(
    (mode: 'split-screen' | 'auto-switch') => {
      if (!activeClip || !activeSource) return;
      userFocusAnchorsRef.current = [];
      liveTrackedAnchorRef.current = null;
      setLiveTrackedAnchor(null);

      updateActiveTimelineClip((clip) => applyTwoSpeakerEditMode(clip, activeSource, mode));

      if (mode === 'split-screen') {
        setMarkerNotice('2-Speaker Split-Screen active (Top: Speaker A · Bottom: Speaker B)');
      } else {
        setMarkerNotice('2-Speaker Auto-Switch active (alternating Speaker A & Speaker B cuts)');
      }
      setTimeout(() => setMarkerNotice(null), 3000);
    },
    [activeClip, activeSource, updateActiveTimelineClip]
  );

  // Programmatically or interactively place a Focus Lock Point at normalized (0..1) coordinates on the source video
  const applyFocusLockAtNormalizedPoint = (
    rawNormX: number,
    rawNormY: number,
    runFullTrajectorySolve = true,
    customTargetLabel?: string
  ) => {
    if (!activeClip) return;
    const normX = Math.max(0.05, Math.min(0.95, rawNormX));
    const normY = Math.max(0.06, Math.min(0.94, rawNormY));

    const liveVideoTime =
      videoRef.current && Number.isFinite(videoRef.current.currentTime)
        ? videoRef.current.currentTime
        : playheadTime;
    const clickTime = Number(liveVideoTime.toFixed(2));

    const captured = captureClickedObjectSignature(videoRef.current, normX, normY);
    if (customTargetLabel) {
      captured.detectedLabel = customTargetLabel;
    }
    resetLiveObjectTrackerState(captured.templateSignature);

    const strategy: SubjectFocusStrategy =
      clickPickMode === 'static' ? 'static-lock' : 'click-track';

    const anchorPt: TrackedObjectPoint = {
      time: clickTime,
      x: captured.refinedX,
      y: captured.refinedY,
      boxW: captured.templateSignature?.boxW ?? 0.14,
      boxH: captured.templateSignature?.boxH ?? 0.16,
      confidence: 1.0,
      isUserAnchor: true,
    };

    // Combine anchors from both our synchronous ref and clip state so no lock point is ever lost
    const pathAnchors = (activeClip.subjectFocus?.trackedPath || []).filter((pt) => pt.isUserAnchor);
    const mergedSourceAnchors = [...userFocusAnchorsRef.current];
    for (const pa of pathAnchors) {
      if (!mergedSourceAnchors.some((m) => Math.abs(m.time - pa.time) <= 0.12)) {
        mergedSourceAnchors.push(pa);
      }
    }

    // Preserve previous user Focus Lock Points at other timestamps (>0.12s apart) so clicking along the timeline strings them together!
    const existingUserAnchors = mergedSourceAnchors.filter(
      (pt) => pt.isUserAnchor && Math.abs(pt.time - anchorPt.time) > 0.12
    );
    const updatedUserAnchors = [...existingUserAnchors, anchorPt].sort((a, b) => a.time - b.time);
    userFocusAnchorsRef.current = updatedUserAnchors;

    // Immediately build a smooth spline curve between all user Focus Lock Points (preserving isUserAnchor: true!)
    const immediateSplineCurve =
      updatedUserAnchors.length >= 2
        ? buildSmoothUserAnchorCurvePoints(updatedUserAnchors, 24)
        : updatedUserAnchors;

    const label =
      strategy === 'click-track'
        ? updatedUserAnchors.length > 1
          ? `${captured.detectedLabel} (${updatedUserAnchors.length} Focus Locks)`
          : captured.detectedLabel
        : `Locked Position (${Math.round(normX * 100)}%, ${Math.round(normY * 100)}%)`;

    const newFocusConfig: SubjectFocusConfig = {
      strategy,
      anchorX: captured.refinedX,
      anchorY: captured.refinedY,
      anchorTime: clickTime,
      targetColorRgb: captured.targetColorRgb,
      templateSignature: captured.templateSignature,
      trackedPath: strategy === 'click-track' ? immediateSplineCurve : undefined,
      label,
    };

    liveTrackedAnchorRef.current = { x: captured.refinedX, y: captured.refinedY };
    setLiveTrackedAnchor({ x: captured.refinedX, y: captured.refinedY });
    applySubjectFocusConfig(newFocusConfig, true);

    // Helper to guarantee all user Focus Lock Points stay merged in any solver path
    const mergeWithLatestUserAnchors = (solverPath: TrackedObjectPoint[]): TrackedObjectPoint[] => {
      const latestAnchors = userFocusAnchorsRef.current;
      const nonUser = solverPath.filter(
        (p) => !p.isUserAnchor && !latestAnchors.some((a) => Math.abs(a.time - p.time) <= 0.1)
      );
      return [...latestAnchors, ...nonUser].sort((a, b) => a.time - b.time);
    };

    // Run full forward/backward Neural + 2D Template + Spline trajectory solve across the video!
    if (runFullTrajectorySolve && strategy === 'click-track' && activeSource?.url) {
      const solveStart = Math.max(0, activeClip.sourceStart);
      const solveEnd = Math.min(
        activeSource.duration,
        Math.max(activeClip.sourceEnd, solveStart + 2)
      );
      setIsSolvingObjectTrack(true);
      setObjectTrackProgress(5);

      solveClickedObjectTrajectory(
        activeSource.url,
        solveStart,
        solveEnd,
        clickTime,
        captured.refinedX,
        captured.refinedY,
        captured.templateSignature,
        captured.targetColorRgb,
        existingUserAnchors,
        (pct, partialPath) => {
          setObjectTrackProgress(pct);
          const safePath = mergeWithLatestUserAnchors(partialPath);
          applySubjectFocusConfig(
            {
              ...newFocusConfig,
              trackedPath: safePath,
              label:
                userFocusAnchorsRef.current.length > 1
                  ? `${captured.detectedLabel} (${userFocusAnchorsRef.current.length} Focus Locks)`
                  : captured.detectedLabel,
            },
            false
          );
        }
      )
        .then((solvedPath) => {
          if (solvedPath && solvedPath.length > 0) {
            const safePath = mergeWithLatestUserAnchors(solvedPath);
            const totalLocks = userFocusAnchorsRef.current.length;
            applySubjectFocusConfig(
              {
                ...newFocusConfig,
                trackedPath: safePath,
                label:
                  totalLocks > 1
                    ? `${captured.detectedLabel} (${totalLocks} Focus Locks)`
                    : captured.detectedLabel,
              },
              false
            );
            setMarkerNotice(
              totalLocks > 1
                ? `Tracked ${totalLocks} focus lock points`
                : `Locked focus point #1 at ${clickTime.toFixed(1)}s`
            );
            setTimeout(() => setMarkerNotice(null), 3200);
          }
        })
        .catch(() => {})
        .finally(() => {
          setIsSolvingObjectTrack(false);
          setObjectTrackProgress(0);
        });
    }
  };

  // Move Speaker A or Speaker B crop box freely anywhere on the Source Video (2D X & Y)
  const updateSpeakerPositionOnClip = useCallback(
    (speaker: 'A' | 'B', rawNormX: number, rawNormY: number) => {
      const clampedX = Number(Math.max(0.06, Math.min(0.94, rawNormX)).toFixed(3));
      const clampedY = Number(Math.max(0.06, Math.min(0.94, rawNormY)).toFixed(3));
      const defaultY = nativeDims.width < nativeDims.height ? 0.39 : 0.44;

      const patchClip = (c: GeneratedClip): GeneratedClip => {
        const nextAX = speaker === 'A' ? clampedX : (c.speakerAX ?? 0.26);
        const nextAY = speaker === 'A' ? clampedY : (c.speakerAY ?? defaultY);
        const nextBX = speaker === 'B' ? clampedX : (c.speakerBX ?? 0.74);
        const nextBY = speaker === 'B' ? clampedY : (c.speakerBY ?? defaultY);

        const isAutoSwitch = c.subjectFocus?.label === '2-Speaker Auto-Switch';
        const nextSubCuts = isAutoSwitch
          ? c.subCuts.map((sc, idx) => {
              const isSpkA = sc.label.includes('Speaker A') || (!sc.label.includes('Speaker B') && idx % 2 === 0);
              return {
                ...sc,
                cropBiasX: Number(((isSpkA ? nextAX : nextBX) - 0.5).toFixed(3)),
              };
            })
          : c.subCuts;

        return {
          ...c,
          speakerAX: nextAX,
          speakerAY: nextAY,
          speakerBX: nextBX,
          speakerBY: nextBY,
          subjectFocus: isAutoSwitch && c.subjectFocus
            ? {
                ...c.subjectFocus,
                anchorY: Number(((nextAY + nextBY) / 2).toFixed(3)),
              }
            : c.subjectFocus,
          subCuts: nextSubCuts,
        };
      };

      if (applyFocusToAllClips) {
        setFullVideoClip((prev) => (prev ? patchClip(prev) : prev));
        setGeneratedClips((prev) => prev.map(patchClip));
      } else {
        updateActiveTimelineClip(patchClip);
      }
    },
    [applyFocusToAllClips, nativeDims, updateActiveTimelineClip]
  );

  // Click or Drag directly on the Source Video to pick ANY object and track it across the clip!
  const handlePointerOnSourceVideo = (
    e: React.MouseEvent<HTMLDivElement>,
    runFullTrajectorySolve = false
  ) => {
    if (!sourceOverlayWrapRef.current || !activeClip) return;
    const rect = sourceOverlayWrapRef.current.getBoundingClientRect();
    const normX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0.06, Math.min(0.94, (e.clientY - rect.top) / rect.height));

    const isTwoSpeakerActive =
      activeClip.backgroundFillStyle === 'split-screen' ||
      activeClip.subjectFocus?.label === '2-Speaker Auto-Switch';

    if (isTwoSpeakerActive) {
      const targetSpk = draggingSpeaker || selectedSpeakerTarget;
      updateSpeakerPositionOnClip(targetSpk, normX, normY);
      return;
    }

    applyFocusLockAtNormalizedPoint(normX, normY, runFullTrajectorySolve);
  };

  // Remove a single user Focus Lock Point by timestamp and smoothly re-blend remaining lock points
  const handleDeleteFocusLockPoint = useCallback(
    (anchorTime: number) => {
      const sourceAnchors =
        userFocusAnchorsRef.current.length > 0
          ? userFocusAnchorsRef.current
          : (activeClip?.subjectFocus?.trackedPath || []).filter((pt) => pt.isUserAnchor);

      const remainingAnchors = sourceAnchors
        .filter((pt) => pt.isUserAnchor && Math.abs(pt.time - anchorTime) > 0.08)
        .sort((a, b) => a.time - b.time);

      userFocusAnchorsRef.current = remainingAnchors;

      if (remainingAnchors.length === 0 || !activeClip?.subjectFocus) {
        liveTrackedAnchorRef.current = null;
        handleSelectSubjectFocusStrategy('auto-salient');
        return;
      }

      const primary = remainingAnchors[remainingAnchors.length - 1];
      const nextCurve =
        remainingAnchors.length >= 2
          ? buildSmoothUserAnchorCurvePoints(remainingAnchors, 24)
          : remainingAnchors;

      applySubjectFocusConfig(
        {
          ...activeClip.subjectFocus,
          anchorX: primary.x,
          anchorY: primary.y,
          anchorTime: primary.time,
          trackedPath: nextCurve,
          label: `Tracked Subject (${remainingAnchors.length} Focus Lock${remainingAnchors.length === 1 ? '' : 's'})`,
        },
        false
      );
      setMarkerNotice(
        `Removed Focus Lock @ ${anchorTime.toFixed(1)}s (${remainingAnchors.length} lock point${remainingAnchors.length === 1 ? '' : 's'} active)`
      );
      setTimeout(() => setMarkerNotice(null), 2600);
    },
    [activeClip, applySubjectFocusConfig, handleSelectSubjectFocusStrategy]
  );

  // Razor Cut at any specific clip timeline time (`targetClipTime` in 0 .. activeClip.duration)
  const handleRazorSplitAtClipTime = useCallback(
    (targetClipTime: number) => {
      if (!activeClip) return;
      const { sourceTime } = clipTimeToSourceTime(activeClip, targetClipTime);

      let didSplit = false;
      let newCutIdx = selectedCutIndex;

      updateActiveTimelineClip((clip) => {
        const nextSubCuts: SubCut[] = [];
        for (let i = 0; i < clip.subCuts.length; i++) {
          const cut = clip.subCuts[i];
          if (
            !didSplit &&
            targetClipTime > cut.timelineStart + 0.2 &&
            targetClipTime < cut.timelineEnd - 0.2 &&
            sourceTime > cut.sourceStart + 0.2 &&
            sourceTime < cut.sourceEnd - 0.2
          ) {
            didSplit = true;
            newCutIdx = nextSubCuts.length + 1;
            const splitSrc = Number(sourceTime.toFixed(2));
            nextSubCuts.push({
              ...cut,
              id: `${cut.id}-a-${Date.now()}`,
              sourceEnd: splitSrc,
              label: `${cut.label.replace(/\s*\(Part.*\)/, '')} (Part 1)`,
            });
            nextSubCuts.push({
              ...cut,
              id: `${cut.id}-b-${Date.now()}`,
              sourceStart: splitSrc,
              label: `Cut @ ${formatSMPTETimecode(splitSrc).slice(3, 8)}`,
              zoom: cut.zoom,
            });
          } else {
            nextSubCuts.push(cut);
          }
        }
        if (!didSplit) return clip;
        const recalc = recalculateClipTimeline(nextSubCuts);
        return {
          ...clip,
          subCuts: recalc.subCuts,
          duration: recalc.duration,
          sourceStart: recalc.sourceStart,
          sourceEnd: recalc.sourceEnd,
        };
      });

      if (didSplit) {
        setSelectedCutIndex(newCutIdx);
        activeCutIdxRef.current = newCutIdx;
        handleSeekClipTime(targetClipTime);
        setMarkerNotice(`Split cut at ${targetClipTime.toFixed(2)}s`);
        setTimeout(() => setMarkerNotice(null), 2200);
      }
    },
    [activeClip, selectedCutIndex, updateActiveTimelineClip, handleSeekClipTime]
  );

  // Split Active Clip at current playhead position
  const handleSplitAtPlayhead = useCallback(() => {
    handleRazorSplitAtClipTime(clipPlayheadTime);
  }, [handleRazorSplitAtClipTime, clipPlayheadTime]);

  // Delete (Ripple-Delete) the currently selected cut on the timeline
  const handleDeleteSelectedCut = useCallback(() => {
    if (!activeClip || activeClip.subCuts.length <= 1) return;
    const idxToDelete = Math.min(selectedCutIndex, activeClip.subCuts.length - 1);
    const deletedCut = activeClip.subCuts[idxToDelete];

    updateActiveTimelineClip((clip) => {
      if (clip.subCuts.length <= 1) return clip;
      const filtered = clip.subCuts.filter((_, i) => i !== idxToDelete);
      const recalc = recalculateClipTimeline(filtered);
      return {
        ...clip,
        subCuts: recalc.subCuts,
        duration: recalc.duration,
        sourceStart: recalc.sourceStart,
        sourceEnd: recalc.sourceEnd,
      };
    });

    const nextIdx = Math.max(0, idxToDelete - 1);
    setSelectedCutIndex(nextIdx);
    activeCutIdxRef.current = nextIdx;
    setMarkerNotice(
      `Deleted Cut #${deletedCut.index} (${(deletedCut.sourceEnd - deletedCut.sourceStart).toFixed(1)}s removed)`
    );
    setTimeout(() => setMarkerNotice(null), 2500);
  }, [activeClip, selectedCutIndex, updateActiveTimelineClip]);

  // Save the currently selected cut on the timeline as its own standalone 9:16 Clip in the list
  const handleSaveSelectedCutAsClip = useCallback(() => {
    if (!activeSource || !activeClip) return;
    const cut =
      activeClip.subCuts[Math.min(selectedCutIndex, activeClip.subCuts.length - 1)] ||
      activeClip.subCuts[0];
    if (!cut) return;

    const dur = Number((cut.sourceEnd - cut.sourceStart).toFixed(2));
    const singleCut: SubCut = {
      ...cut,
      id: `saved-cut-${Date.now()}`,
      index: 1,
      timelineStart: 0,
      timelineEnd: dur,
    };

    const newClip: GeneratedClip = {
      id: `manual-clip-${Date.now()}`,
      name: `Razor Clip (${formatSMPTETimecode(cut.sourceStart).slice(3, 8)}–${formatSMPTETimecode(cut.sourceEnd).slice(3, 8)})`,
      sourceVideoId: activeSource.id,
      schemeId: activeScheme.id,
      schemeName: activeScheme.name,
      clipCreationMode: 'clip-segment',
      viralScore: 94,
      hookReason: `Extracted from timeline Cut #${cut.index} (${dur.toFixed(1)}s)`,
      sourceStart: cut.sourceStart,
      sourceEnd: cut.sourceEnd,
      duration: dur,
      trackingMode: activeScheme.trackingMode,
      subjectFocus: activeClip.subjectFocus,
      trackingOffsetX: activeClip.trackingOffsetX,
      trackingSmoothing: activeClip.trackingSmoothing,
      zoomScale: cut.zoom,
      captionText: activeClip.captionText,
      captionStyle: activeClip.captionStyle,
      safeZoneGuide: activeClip.safeZoneGuide,
      subCuts: [singleCut],
      captions: [],
      manualKeyframes: [],
    };

    setGeneratedClips((prev) => [newClip, ...prev]);
    setMarkerNotice(`Saved Cut #${cut.index} (${dur.toFixed(1)}s) to 9:16 Clips list!`);
    setTimeout(() => setMarkerNotice(null), 2800);
  }, [activeSource, activeClip, selectedCutIndex, activeScheme]);

  // Set In Marker at Current Playhead (Shortcut: I)
  const handleSetInMarkerAtPlayhead = useCallback(() => {
    if (!activeSource) return;
    const t = Number(Math.max(0, Math.min(activeSource.duration - 0.5, playheadTime)).toFixed(2));
    setInMarker(t);
    setOutMarker((prevOut) => {
      if (prevOut === null || prevOut <= t + 0.5) {
        return Number(
          Math.min(
            activeSource.duration,
            t + Math.min(activeScheme.targetClipDuration || 20, activeSource.duration - t)
          ).toFixed(2)
        );
      }
      return prevOut;
    });
  }, [activeSource, playheadTime, activeScheme.targetClipDuration]);

  // Set Out Marker at Current Playhead (Shortcut: O)
  const handleSetOutMarkerAtPlayhead = useCallback(() => {
    if (!activeSource) return;
    const t = Number(Math.max(0.5, Math.min(activeSource.duration, playheadTime)).toFixed(2));
    setOutMarker(t);
    setInMarker((prevIn) => {
      if (prevIn === null || prevIn >= t - 0.5) {
        return Number(
          Math.max(0, t - Math.min(activeScheme.targetClipDuration || 20, t)).toFixed(2)
        );
      }
      return prevIn;
    });
  }, [activeSource, playheadTime, activeScheme.targetClipDuration]);

  // Create a new 9:16 Clip from the current [inMarker, outMarker] selection
  const handleCreateClipFromMarkers = useCallback(
    (switchToNewClip: boolean, makeCondensedEdit = false) => {
      if (!activeSource || inMarker === null || outMarker === null) return;
      const start = Number(Math.max(0, Math.min(inMarker, outMarker)).toFixed(2));
      const end = Number(
        Math.min(
          activeSource.duration,
          Math.max(start + 1.0, Math.max(inMarker, outMarker))
        ).toFixed(2)
      );
      const spanDur = Number((end - start).toFixed(2));

      let subCuts: SubCut[];
      let clipMode: ClipCreationMode = 'clip-segment';

      if (makeCondensedEdit) {
        clipMode = 'condensed-edit';
        const targetDur = Math.min(spanDur, Math.max(3, activeScheme.targetClipDuration || 20));
        subCuts = buildCondensedEditSubCuts(
          targetDur,
          activeSource,
          activeScheme,
          0,
          1,
          start,
          end
        );
      } else {
        subCuts = [
          {
            id: `manual-cut-${Date.now()}`,
            index: 1,
            sourceStart: start,
            sourceEnd: end,
            timelineStart: 0,
            timelineEnd: spanDur,
            label: `Marked Segment (${formatSMPTETimecode(start).slice(3, 8)}–${formatSMPTETimecode(end).slice(3, 8)})`,
            zoom: 1.0,
            cropBiasX: 0,
            isBeatCut: false,
          },
        ];
      }

      const recalc = recalculateClipTimeline(subCuts);

      const newClip: GeneratedClip = {
        id: `manual-clip-${Date.now()}`,
        name: makeCondensedEdit
          ? `Compilation In→Out (${recalc.duration.toFixed(1)}s • ${recalc.subCuts.length} Cuts)`
          : `Marked Clip (${formatSMPTETimecode(start).slice(3, 8)}–${formatSMPTETimecode(end).slice(3, 8)})`,
        sourceVideoId: activeSource.id,
        schemeId: activeScheme.id,
        schemeName: activeScheme.name,
        clipCreationMode: clipMode,
        viralScore: 96,
        hookReason: makeCondensedEdit
          ? `Compilation of ${recalc.subCuts.length} highlights from marked range ${start.toFixed(1)}s–${end.toFixed(1)}s`
          : `Manually clipped via In/Out markers (${start.toFixed(1)}s → ${end.toFixed(1)}s, ${recalc.duration.toFixed(1)}s)`,
        sourceStart: recalc.sourceStart,
        sourceEnd: recalc.sourceEnd,
        duration: recalc.duration,
        trackingMode: activeScheme.trackingMode,
        subjectFocus: activeClip?.subjectFocus,
        trackingOffsetX: 0,
        trackingSmoothing: activeScheme.trackingSmoothing,
        zoomScale: makeCondensedEdit ? activeScheme.punchInZoom : 1.0,
        captionText: '',
        captionStyle: activeScheme.captionStyle,
        safeZoneGuide: activeScheme.safeZoneGuide,
        subCuts: recalc.subCuts,
        captions: [],
        manualKeyframes: [],
      };

      setGeneratedClips((prev) => [newClip, ...prev]);

      if (switchToNewClip) {
        setTimelineMode('elected-clip');
        setActiveClipId(newClip.id);
        activeCutIdxRef.current = 0;
        setSelectedCutIndex(0);
        setClipPlayheadTime(0);
        setPlayheadTime(recalc.subCuts[0]?.sourceStart ?? start);
        setIsLoopingInOut(false);
        if (videoRef.current) {
          videoRef.current.currentTime = recalc.subCuts[0]?.sourceStart ?? start;
        }
        setMarkerNotice(
          `Created & opened "${newClip.name}" (${recalc.duration.toFixed(1)}s) on timeline!`
        );
      } else {
        setMarkerNotice(`Added "${newClip.name}" (${recalc.duration.toFixed(1)}s) to clips list!`);
      }
      setTimeout(() => setMarkerNotice(null), 3000);
    },
    [activeSource, inMarker, outMarker, activeScheme, activeClip?.subjectFocus]
  );

  // Select a Generated Clip and put it on the timeline by itself
  const selectClip = useCallback((clip: GeneratedClip) => {
    setTimelineMode('elected-clip');
    setActiveClipId(clip.id);
    setIsLoopingInOut(false);
    activeCutIdxRef.current = 0;
    setSelectedCutIndex(0);
    setClipPlayheadTime(0);
    const startSrc = clip.subCuts[0]?.sourceStart ?? clip.sourceStart;
    setPlayheadTime(startSrc);
    if (videoRef.current) {
      videoRef.current.currentTime = startSrc;
    }
  }, []);

  // 3-Stage Transcript-First AI Viral Showrunner & Common-Thread Narrative Director
  // NEVER runs blind instant math heuristics! First indexes the full spoken transcript, then uses
  // Gemini 4 Argon to research common threads & viral hooks, and snaps every cut to sentence boundaries.
  const handleGenerateClipsFromFullVideo = useCallback(
    async (
      modeOverride?: ClipCreationMode,
      customScheme?: EditingScheme,
      customFocusPrompt?: string
    ) => {
      if (!activeSource || isGeneratingClips) return;
      const baseScheme = customScheme || activeScheme;
      const mode: ClipCreationMode = modeOverride || baseScheme.clipCreationMode || 'clip-segment';
      const targetScheme: EditingScheme = {
        ...baseScheme,
        clipCreationMode: mode,
      };
      setActiveScheme(targetScheme);

      const currentFocus = activeClip?.subjectFocus;
      const focusPrompt = (customFocusPrompt ?? editorialFocusInput).trim();
      const modeLabel =
        mode === 'condensed-edit' ? 'compilations' : 'viral clips';

      setIsGeneratingClips(true);
      setClipGenerationProgress(8);
      setClipGenerationStage(
        `Indexing transcript (0:00–${Math.round(activeSource.duration)}s)...`
      );
      setMarkerNotice(`Indexing transcript and analyzing ${modeLabel}...`);

      try {
        // STAGE 1: Ensure full video speech-to-text transcript is indexed (cached after first run!)
        const fullTranscript = await ensureFullSourceTranscript({
          source: activeSource,
          videoBlob: uploadedVideoBlobRef.current,
          aiSettings,
          existingFullVideoCaptions: fullVideoClip?.captions,
          onStatus: (msg, pct) => {
            setClipGenerationStage(sanitizeCleanText(msg));
            setClipGenerationProgress(Math.min(55, Math.max(8, Math.round(pct * 0.55))));
            setMarkerNotice(sanitizeCleanText(msg));
          },
        });

        // Cache the full transcript on activeSource and fullVideoClip so it never has to re-run
        if (fullTranscript.length > 0) {
          setActiveSource((prev) =>
            prev ? { ...prev, transcriptSegments: fullTranscript } : prev
          );
          setFullVideoClip((prev) =>
            prev && prev.captions.length === 0
              ? {
                  ...prev,
                  captions: fullTranscript,
                  captionText: fullTranscript[0]?.text || prev.captionText,
                }
              : prev
          );
        }

        // STAGE 2: Deep Transcript Research, Common-Thread Synthesis & Viral Mechanics Analysis
        const stage2Msg =
          mode === 'condensed-edit'
            ? `Synthesizing ${targetScheme.maxClipsCount} compilations (${targetScheme.targetClipDuration}s)...`
            : `Selecting top ${targetScheme.maxClipsCount} viral clips (${targetScheme.targetClipDuration}s)...`;
        setClipGenerationStage(stage2Msg);
        setClipGenerationProgress(72);
        setMarkerNotice(stage2Msg);

        const aiRes = await generateClipsWithMultimodalAI(
          activeSource,
          targetScheme,
          aiSettings,
          {
            editorialFocusPrompt: focusPrompt || undefined,
            sourceTranscript: fullTranscript,
          }
        );

        // STAGE 3: Sentence-Boundary Alignment & Word-Level Karaoke Caption Sync
        setClipGenerationStage('Aligning sentence boundaries and captions...');
        setClipGenerationProgress(94);

        const finalRawClips =
          aiRes.clips && aiRes.clips.length > 0
            ? aiRes.clips
            : generateClipsFromScheme(
                { ...activeSource, transcriptSegments: fullTranscript },
                targetScheme
              );

        const withFocus = finalRawClips.map((c) =>
          currentFocus ? { ...c, subjectFocus: currentFocus } : c
        );

        setGeneratedClips(withFocus);
        if (withFocus[0]) {
          selectClip(withFocus[0]);
        }

        const providerLabel = aiRes.providerUsed || 'gemini-4-argon';
        setMarkerNotice(`Generated ${withFocus.length} ${modeLabel}.`);

        const summaryLines = withFocus
          .map((c, idx) => `${idx + 1}. ${c.name} (${c.duration.toFixed(1)}s)`)
          .join('\n');

        setChatMessages((prev) => [
          ...prev,
          {
            id: `ai-showrunner-${Date.now()}`,
            role: 'assistant',
            content: `Generated ${withFocus.length} ${modeLabel} from ${fullTranscript.length} indexed phrases:\n${summaryLines}`,
            timestamp: new Date().toISOString(),
            providerBadge: providerLabel,
            liveApiUsed: true,
            operationBadges: [
              `${fullTranscript.length} Phrases`,
              `${withFocus.length} Clips`,
            ],
          },
        ]);
      } catch (err: any) {
        setMarkerNotice(`Error: ${err?.message || 'Could not generate clips'}`);
      } finally {
        setIsGeneratingClips(false);
        setClipGenerationStage('');
        setClipGenerationProgress(0);
        setTimeout(() => setMarkerNotice(null), 4000);
      }
    },
    [
      activeSource,
      isGeneratingClips,
      activeScheme,
      activeClip?.subjectFocus,
      editorialFocusInput,
      aiSettings,
      fullVideoClip?.captions,
      selectClip,
    ]
  );

  // Keyboard shortcuts: Space (Play/Pause), C (Razor Blade Toggle), I (Set In), O (Set Out), Delete/Backspace (Delete Selected Cut)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay(false);
      } else if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setIsMuted((prev) => {
          const next = !prev;
          if (videoRef.current) videoRef.current.muted = next;
          return next;
        });
      } else if (e.code === 'KeyC') {
        e.preventDefault();
        setIsRazorMode((prev) => !prev);
      } else if (e.code === 'KeyI') {
        e.preventDefault();
        handleSetInMarkerAtPlayhead();
      } else if (e.code === 'KeyO') {
        e.preventDefault();
        handleSetOutMarkerAtPlayhead();
      } else if (
        (e.code === 'Delete' || e.code === 'Backspace') &&
        activeClip &&
        activeClip.subCuts.length > 1
      ) {
        e.preventDefault();
        handleDeleteSelectedCut();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    handleTogglePlay,
    handleSetInMarkerAtPlayhead,
    handleSetOutMarkerAtPlayhead,
    handleDeleteSelectedCut,
    activeClip,
  ]);

  // Select Full Uploaded Video and put it on the timeline by itself
  const selectFullVideoOnTimeline = useCallback(() => {
    if (!activeSource) return;
    if (!fullVideoClip) {
      setFullVideoClip(createInitialFullVideoClip(activeSource, activeScheme));
    }
    setTimelineMode('full-source');
    setIsLoopingInOut(false);
    activeCutIdxRef.current = 0;
    setSelectedCutIndex(0);
    setClipPlayheadTime(0);
    setPlayheadTime(0);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
    }
    if (inMarker === null || outMarker === null) {
      setInMarker(0);
      setOutMarker(
        Number(
          Math.min(activeSource.duration, activeScheme.targetClipDuration || 20).toFixed(2)
        )
      );
    }
  }, [
    activeSource,
    fullVideoClip,
    createInitialFullVideoClip,
    activeScheme,
    inMarker,
    outMarker,
  ]);

  // Clear the currently loaded video and reset the workspace
  const handleClearVideo = useCallback(
    (e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (!activeSource) {
        setMarkerNotice('No video is currently loaded.');
        setTimeout(() => setMarkerNotice(null), 2200);
        return;
      }
      if (videoRef.current) {
        videoRef.current.pause();
        videoRef.current.removeAttribute('src');
        videoRef.current.load();
      }
      if (activeSource.url && activeSource.url.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(activeSource.url);
        } catch {
          // ignore revoke error
        }
      }
      setIsPlaying(false);
      setIsLoopingInOut(false);
      uploadedVideoBlobRef.current = null;
      userFocusAnchorsRef.current = [];
      setActiveSource(null);
      setFullVideoClip(null);
      setGeneratedClips([]);
      setActiveClipId(null);
      setTimelineMode('full-source');
      activeCutIdxRef.current = 0;
      setSelectedCutIndex(0);
      setPlayheadTime(0);
      setClipPlayheadTime(0);
      setInMarker(null);
      setOutMarker(null);
      if (sourceFileInputRef.current) {
        sourceFileInputRef.current.value = '';
      }
      setMarkerNotice('Cleared video.');
      setTimeout(() => setMarkerNotice(null), 2600);
    },
    [activeSource]
  );

  // Delete all generated/custom clips while keeping the uploaded source video on the timeline
  const handleClearAllClips = useCallback(
    (e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      if (generatedClips.length === 0) {
        setMarkerNotice('No clips to delete.');
        setTimeout(() => setMarkerNotice(null), 2200);
        return;
      }
      const removedCount = generatedClips.length;
      setGeneratedClips([]);
      setActiveClipId(null);
      setTimelineMode('full-source');
      setIsLoopingInOut(false);
      activeCutIdxRef.current = 0;
      setSelectedCutIndex(0);
      setClipPlayheadTime(0);
      setPlayheadTime(0);
      if (videoRef.current) {
        videoRef.current.currentTime = 0;
      }
      setMarkerNotice(`Deleted ${removedCount} clips.`);
      setTimeout(() => setMarkerNotice(null), 2600);
    },
    [generatedClips.length]
  );

  // Delete a single clip from the Ranked Clips & Compilations list
  const handleDeleteSingleClip = useCallback(
    (clipId: string, e?: React.MouseEvent) => {
      if (e) e.stopPropagation();
      setGeneratedClips((prev) => {
        const remaining = prev.filter((c) => c.id !== clipId);
        if (activeClipId === clipId) {
          if (remaining.length > 0) {
            setActiveClipId(remaining[0].id);
            setTimelineMode('elected-clip');
          } else {
            setActiveClipId(null);
            setTimelineMode('full-source');
          }
          activeCutIdxRef.current = 0;
          setSelectedCutIndex(0);
          setClipPlayheadTime(0);
        }
        return remaining;
      });
      setMarkerNotice('Clip deleted.');
      setTimeout(() => setMarkerNotice(null), 2000);
    },
    [activeClipId]
  );

  // Upload & Analyze Real Video — Loads the Full Uploaded Video onto the timeline with NO automatic clipping!
  const handleUploadVideoFile = async (file: File) => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    setIsLoopingInOut(false);
    setIsAnalyzing(true);
    setAnalysisStatus('Loading video...');

    try {
      const analyzed = await analyzeUploadedVideo(file, (stage, pct) => {
        setAnalysisStatus(`${stage} (${pct}%)`);
      });

      uploadedVideoBlobRef.current = file;
      const newProjId = `proj-${Date.now()}`;
      const cleanTitle = file.name.replace(/\.[^/.]+$/, '');
      setCurrentProjectId(newProjId);
      setCurrentProjectName(cleanTitle);
      userFocusAnchorsRef.current = [];

      // Try uploading video to Vercel Blob in background if configured
      tryUploadVideoToVercelBlob(file.name, file).then((cloudUrl) => {
        if (cloudUrl) {
          setActiveSource((prev) =>
            prev ? ({ ...prev, cloudVideoUrl: cloudUrl } as any) : prev
          );
        }
      });

      setNativeDims({ width: analyzed.width, height: analyzed.height });
      setActiveSource(analyzed);
      const initialFullClip = createInitialFullVideoClip(analyzed, activeScheme);
      setFullVideoClip(initialFullClip);

      // Clear any previously generated clips and place ONLY the Full Uploaded Video on the timeline
      setGeneratedClips([]);
      setActiveClipId(null);
      setTimelineMode('full-source');
      activeCutIdxRef.current = 0;
      setSelectedCutIndex(0);
      setClipPlayheadTime(0);
      setPlayheadTime(0);

      // Set In/Out markers to the full video span (0 -> full duration) so nothing is pre-clipped
      setInMarker(0);
      setOutMarker(Number(analyzed.duration.toFixed(2)));

      setChatMessages([
        {
          id: `upload-ready-${Date.now()}`,
          role: 'assistant',
          content: `Loaded ${file.name} (${analyzed.width}×${analyzed.height}, ${analyzed.duration}s).`,
          timestamp: new Date().toISOString(),
          providerBadge: 'Source Ready',
        },
      ]);
    } catch (err: any) {
      alert(`Failed to load video: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsAnalyzing(false);
      setAnalysisStatus('');
    }
  };

  // Save current project (called manually or via auto-save)
  const handleSaveCurrentProject = useCallback(
    async (customName?: string, asNewProject = false) => {
      if (!activeSource || !authUser) return;
      const targetId = asNewProject ? `proj-${Date.now()}` : currentProjectId;
      const targetName = (customName ?? currentProjectName).trim() || activeSource.name;
      if (asNewProject) {
        setCurrentProjectId(targetId);
      }
      setCurrentProjectName(targetName);
      setIsSavingProject(true);
      try {
        await saveStudioProject({
          projectId: targetId,
          projectName: targetName,
          user: authUser,
          source: activeSource,
          videoBlob: uploadedVideoBlobRef.current,
          fullVideoClip,
          generatedClips,
          activeClipId,
          timelineMode,
          activeScheme,
          inMarker,
          outMarker,
          chatMessages,
        });
        if (customName !== undefined) {
          setMarkerNotice(`Saved project "${targetName}"!`);
          setTimeout(() => setMarkerNotice(null), 2600);
        }
      } finally {
        setIsSavingProject(false);
      }
    },
    [
      activeSource,
      authUser,
      currentProjectId,
      currentProjectName,
      fullVideoClip,
      generatedClips,
      activeClipId,
      timelineMode,
      activeScheme,
      inMarker,
      outMarker,
      chatMessages,
    ]
  );

  // Debounced Auto-Save whenever timeline cuts, clips, or Focus Lock Points change
  useEffect(() => {
    if (!activeSource || !authUser) return;
    const timer = setTimeout(() => {
      handleSaveCurrentProject();
    }, 1200);
    return () => clearTimeout(timer);
  }, [
    activeSource,
    authUser,
    fullVideoClip,
    generatedClips,
    activeClipId,
    timelineMode,
    activeScheme,
    inMarker,
    outMarker,
    handleSaveCurrentProject,
  ]);

  // Recall a saved project by ID
  const handleRecallProject = useCallback(async (projectId: string) => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    setIsLoopingInOut(false);

    const recalled = await recallStudioProject(projectId);
    if (!recalled || !recalled.record.projectState) {
      alert('Could not recall project state.');
      return;
    }

    const { record, restoredVideoUrl, videoBlob } = recalled;
    const st = record.projectState;
    if (!st) return;
    uploadedVideoBlobRef.current = videoBlob;

    const restoredSource: SourceVideoAsset = {
      ...st.sourceAsset,
      url: restoredVideoUrl || '',
    };

    setCurrentProjectId(record.id);
    setCurrentProjectName(record.name);
    setNativeDims({
      width: restoredSource.width || 1920,
      height: restoredSource.height || 1080,
    });
    setActiveSource(restoredSource);
    setFullVideoClip(st.fullVideoClip);
    setGeneratedClips(st.generatedClips || []);
    setActiveClipId(st.activeClipId);
    setTimelineMode(st.timelineMode || 'full-source');
    if (st.activeScheme) {
      setActiveScheme(st.activeScheme);
    }
    setInMarker(st.inMarker ?? 0);
    setOutMarker(st.outMarker ?? restoredSource.duration);
    if (Array.isArray(st.chatMessages) && st.chatMessages.length > 0) {
      // Filter out legacy verbose system boilerplate messages from older saved projects
      const cleaned = st.chatMessages
        .filter(
          (m) =>
            m.id !== 'welcome' &&
            !m.id.startsWith('upload-ready-') &&
            !m.id.startsWith('ai-showrunner-') &&
            !m.content.includes('Upload a video to: (1)') &&
            !m.content.includes('Nothing was clipped automatically') &&
            !m.content.includes('Completed 3-stage transcript')
        )
        .map((m) => ({
          ...m,
          content: sanitizeCleanText(m.content),
          operationBadges: m.operationBadges?.map((b) => sanitizeCleanText(b)),
        }));
      setChatMessages(
        cleaned.length > 0
          ? cleaned
          : [
              {
                id: 'welcome',
                role: 'assistant',
                content: `Loaded ${restoredSource.name} (${restoredSource.duration}s).`,
                timestamp: new Date().toISOString(),
                providerBadge: 'Ready',
              },
            ]
      );
    }

    const activeRestoredClip =
      st.timelineMode === 'full-source'
        ? st.fullVideoClip
        : (st.generatedClips || []).find((c) => c.id === st.activeClipId) ||
          (st.generatedClips || [])[0] ||
          st.fullVideoClip;

    const restoredLocks = (activeRestoredClip?.subjectFocus?.trackedPath || []).filter(
      (p) => p.isUserAnchor
    );
    userFocusAnchorsRef.current = restoredLocks;

    activeCutIdxRef.current = 0;
    setSelectedCutIndex(0);
    setClipPlayheadTime(0);
    setPlayheadTime(0);

    setMarkerNotice(
      restoredVideoUrl
        ? `Recalled project "${record.name}" (${st.generatedClips?.length || 0} clips, ${restoredLocks.length} Focus Locks)`
        : `Recalled project "${record.name}" — re-upload "${restoredSource.name}" to reconnect video file`
    );
    setTimeout(() => setMarkerNotice(null), 3500);
  }, []);

  // Automatically recall the most recent project on initial load when authenticated
  const didAutoRecallRef = useRef(false);
  useEffect(() => {
    if (!authUser || activeSource || didAutoRecallRef.current) return;
    didAutoRecallRef.current = true;
    const lastId = getLastActiveProjectId();
    if (lastId) {
      handleRecallProject(lastId).catch(() => {});
    }
  }, [authUser, activeSource, handleRecallProject]);

  // Upload Reference Video to Clone Style into a Saved Scheme
  const handleUploadReferenceVideo = async (file: File) => {
    setIsCloningRef(true);
    setAnalysisStatus(`Analyzing reference editing style from "${file.name}"...`);
    try {
      const extracted = await extractReferenceVideoTelemetry(file, (msg, pct) => {
        setAnalysisStatus(`${msg} (${pct}%)`);
      });
      const { scheme, styleSummary, providerUsed } = await synthesizeSchemeFromReference(
        file.name,
        extracted.telemetry,
        extracted.keyframesBase64,
        aiSettings,
        'Clone the exact cut pacing, hook speed, and punch-in zoom energy.'
      );

      const enrichedScheme: EditingScheme = {
        ...scheme,
        clipCreationMode: activeScheme.clipCreationMode || 'condensed-edit',
        maxClipsCount: activeScheme.maxClipsCount || 4,
        maxClipDuration: 180,
      };

      const nextSchemes = [enrichedScheme, ...schemes];
      setSchemes(nextSchemes);
      saveSchemesToStorage(nextSchemes);
      setActiveScheme(enrichedScheme);

      setChatMessages((prev) => [
        ...prev,
        {
          id: `ref-cloned-${Date.now()}`,
          role: 'assistant',
          content: `${styleSummary} Saved new Editing Scheme: "${enrichedScheme.name}".`,
          timestamp: new Date().toISOString(),
          providerBadge: providerUsed,
          operationBadges: [
            `Cloned: ${file.name}`,
            `${enrichedScheme.targetAvgShotLength}s ASL`,
            `${enrichedScheme.punchInZoom}x Zoom`,
          ],
        },
      ]);
    } catch (err: any) {
      alert(`Reference style clone failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsCloningRef(false);
      setAnalysisStatus('');
    }
  };

  // Save or Re-Apply Editing Scheme
  const handleSaveAndApplyScheme = (applyToVideo: boolean, schemeOverride?: EditingScheme) => {
    const targetScheme = schemeOverride || activeScheme;
    setSchemes((prev) => {
      const exists = prev.some((s) => s.id === targetScheme.id);
      const next = exists
        ? prev.map((s) => (s.id === targetScheme.id ? targetScheme : s))
        : [targetScheme, ...prev];
      saveSchemesToStorage(next);
      return next;
    });

    if (applyToVideo && activeSource) {
      handleGenerateClipsFromFullVideo(
        targetScheme.clipCreationMode || 'clip-segment',
        targetScheme
      );
      setSchemeSavedNotice('Running AI Showrunner with saved scheme...');
    } else {
      setSchemeSavedNotice('Scheme saved!');
    }
    setTimeout(() => setSchemeSavedNotice(null), 2500);
  };

  // Capture current video frame at playhead as compact JPEG data URL for Gemini 4 Argon Multimodal Vision
  const captureCurrentVideoFrameDataUrl = (): string | undefined => {
    const vid = videoRef.current;
    if (!vid || !vid.videoWidth || !vid.videoHeight) return undefined;
    try {
      const targetW = 640;
      const targetH = Math.max(180, Math.round((vid.videoHeight / vid.videoWidth) * targetW));
      const c = document.createElement('canvas');
      c.width = targetW;
      c.height = targetH;
      const ctx = c.getContext('2d');
      if (!ctx) return undefined;
      ctx.drawImage(vid, 0, 0, targetW, targetH);
      return c.toDataURL('image/jpeg', 0.72);
    } catch {
      return undefined;
    }
  };

  // Convert pasted or selected files (images, reference videos, text/SRT scripts) into CopilotAttachments
  const handleAddFilesToChat = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    const newAttachments: CopilotAttachment[] = [];

    for (const file of files.slice(0, 6)) {
      const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const mime = file.type || 'application/octet-stream';

      if (mime.startsWith('image/')) {
        try {
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const img = new Image();
            const objUrl = URL.createObjectURL(file);
            img.onload = () => {
              const maxW = 840;
              const scale = img.width > maxW ? maxW / img.width : 1;
              const w = Math.max(64, Math.round(img.width * scale));
              const h = Math.max(64, Math.round(img.height * scale));
              const c = document.createElement('canvas');
              c.width = w;
              c.height = h;
              const ctx = c.getContext('2d');
              if (ctx) ctx.drawImage(img, 0, 0, w, h);
              URL.revokeObjectURL(objUrl);
              resolve(c.toDataURL('image/jpeg', 0.82));
            };
            img.onerror = () => {
              URL.revokeObjectURL(objUrl);
              reject(new Error('Failed to load image'));
            };
            img.src = objUrl;
          });
          newAttachments.push({
            id,
            name: file.name || 'Pasted Image.jpg',
            mimeType: 'image/jpeg',
            kind: 'image',
            dataUrl,
            sizeBytes: file.size,
          });
        } catch {}
      } else if (mime.startsWith('video/')) {
        try {
          const frames = await new Promise<string[]>((resolve) => {
            const vid = document.createElement('video');
            const objUrl = URL.createObjectURL(file);
            vid.muted = true;
            vid.playsInline = true;
            vid.src = objUrl;
            const sampled: string[] = [];
            vid.onloadedmetadata = async () => {
              const dur = Math.max(1, vid.duration || 4);
              const times = [dur * 0.12, dur * 0.36, dur * 0.62, dur * 0.85];
              for (const t of times) {
                await new Promise<void>((resSeek) => {
                  vid.onseeked = () => {
                    const w = 480;
                    const h = Math.max(160, Math.round(((vid.videoHeight || 270) / (vid.videoWidth || 480)) * w));
                    const c = document.createElement('canvas');
                    c.width = w;
                    c.height = h;
                    const ctx = c.getContext('2d');
                    if (ctx) {
                      ctx.drawImage(vid, 0, 0, w, h);
                      sampled.push(c.toDataURL('image/jpeg', 0.75));
                    }
                    resSeek();
                  };
                  vid.currentTime = t;
                });
              }
              URL.revokeObjectURL(objUrl);
              resolve(sampled);
            };
            vid.onerror = () => {
              URL.revokeObjectURL(objUrl);
              resolve([]);
            };
          });
          newAttachments.push({
            id,
            name: file.name,
            mimeType: mime,
            kind: 'video',
            dataUrl: frames[0],
            videoFramesDataUrls: frames,
            sizeBytes: file.size,
          });
        } catch {}
      } else {
        try {
          const textContent = await file.text();
          newAttachments.push({
            id,
            name: file.name,
            mimeType: mime || 'text/plain',
            kind: 'text',
            textContent: textContent.slice(0, 15000),
            sizeBytes: file.size,
          });
        } catch {}
      }
    }

    if (newAttachments.length > 0) {
      setPendingChatAttachments((prev) => [...prev, ...newAttachments].slice(0, 6));
    }
  };

  // Handle Ctrl+V / Cmd+V clipboard paste of screenshots, images, or files in the Agent Chat
  const handleChatPaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      handleAddFilesToChat(files);
    }
  };

  // Run Real AI Speech-to-Text Transcription on the Active Clip's Full Audio Track (Chunked across full duration)
  const handleRunAITranscription = useCallback(async () => {
    if (!activeClip || !activeSource || isTranscribingAudio) return;
    setIsTranscribingAudio(true);
    setTranscriptionProgress(5);
    setMarkerNotice('Transcribing audio...');

    try {
      const res = await transcribeClipAudioWithAI({
        clip: activeClip,
        source: activeSource,
        videoBlob: uploadedVideoBlobRef.current,
        aiSettings,
        clipPlayheadTime,
        onStatus: (msg) => setMarkerNotice(sanitizeCleanText(msg)),
        onPartialCaptions: (captionsSoFar, pct) => {
          setTranscriptionProgress(pct);
          updateActiveTimelineClip((c) => ({
            ...c,
            captions: captionsSoFar,
            captionText: captionsSoFar[0]?.text || c.captionText,
          }));
        },
      });

      if (res.captions.length > 0) {
        updateActiveTimelineClip((c) => ({
          ...c,
          captions: res.captions,
          captionText: res.captions[0]?.text || c.captionText,
        }));
        setMarkerNotice(`Transcribed ${res.captions.length} caption segments.`);
        setChatMessages((prev) => [
          ...prev,
          {
            id: `transcribed-${Date.now()}`,
            role: 'assistant',
            content: `Transcribed ${res.captions.length} caption segments (${activeClip.duration.toFixed(0)}s).`,
            timestamp: new Date().toISOString(),
            providerBadge: res.providerUsed,
            liveApiUsed: true,
            operationBadges: [`${res.captions.length} Captions`],
          },
        ]);
      } else {
        setMarkerNotice(res.error || 'No speech detected in this audio segment.');
      }
    } catch (err: any) {
      setMarkerNotice(`Transcription failed: ${err?.message || 'Error'}`);
    } finally {
      setIsTranscribingAudio(false);
      setTranscriptionProgress(0);
      setTimeout(() => setMarkerNotice(null), 3500);
    }
  }, [
    activeClip,
    activeSource,
    isTranscribingAudio,
    aiSettings,
    clipPlayheadTime,
    updateActiveTimelineClip,
  ]);

  // Send Studio Agent / Cut Iteration Feedback in Right Pane Chat
  const handleSendChat = async (
    promptText: string,
    attachmentsOverride?: CopilotAttachment[]
  ) => {
    const attachmentsToSend = attachmentsOverride ?? pendingChatAttachments;
    const trimmedPrompt = promptText.trim();
    if (!trimmedPrompt && attachmentsToSend.length === 0) return;

    const effectivePrompt =
      trimmedPrompt ||
      `Analyze the attached reference (${attachmentsToSend.map((a) => a.name).join(', ')}) and apply it to my 9:16 edit.`;

    if (!attachmentsOverride && pendingChatAttachments.length > 0) {
      setPendingChatAttachments([]);
    }

    const userMsg: CopilotChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: effectivePrompt,
      timestamp: new Date().toISOString(),
      clipId: activeClip?.id,
      clipName: activeClip?.name,
      playheadTime: clipPlayheadTime,
      attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setIsCopilotBusy(true);

    const snapshotId = `snap-${Date.now()}`;
    const preEditSnapshot: CopilotRevisionSnapshot | null = activeClip
      ? {
          id: snapshotId,
          timestamp: new Date().toISOString(),
          clipSnapshot: JSON.parse(JSON.stringify(activeClip)),
          summaryBadges: [],
        }
      : null;

    try {
      const provider = aiSettings.activeProvider;
      const currentFrameDataUrl = captureCurrentVideoFrameDataUrl();
      const focusLocksCount = (activeClip?.subjectFocus?.trackedPath || []).filter(
        (p) => p.isUserAnchor
      ).length;

      // Only extract audio WAV if the user is explicitly asking to transcribe speech (NOT when styling/moving captions!)
      const isCaptionStyleOrPositionRequest =
        /\b(move|put|place|top|bottom|middle|center|font|graffiti|marker|comic|bangers|impact|serif|mono|color|size|bigger|smaller|larger|hide|remove\s+box|background\s+bar)\b/i.test(
          effectivePrompt
        );
      let extractedAudio: {
        wavBase64: string | null;
        startClipTime: number;
        extractedDuration: number;
      } | null = null;
      if (
        activeClip &&
        activeSource &&
        !isCaptionStyleOrPositionRequest &&
        /\b(transcribe|what\s+are\s+they\s+saying|add\s+(word[\s-]by[\s-]word\s+)?(karaoke\s+)?(captions?|subtitles?))\b/i.test(
          effectivePrompt
        )
      ) {
        extractedAudio = await extractTimelineAudioWavBase64(
          activeClip,
          activeSource,
          uploadedVideoBlobRef.current,
          clipPlayheadTime,
          45
        );
      }

      const transcriptSource =
        activeSource?.transcriptSegments && activeSource.transcriptSegments.length > 0
          ? activeSource.transcriptSegments
          : activeClip?.captions || [];

      const resp = await fetch('/api/ai-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: aiSettings.models[provider],
          apiKeyOverride: aiSettings.apiKeys[provider],
          userPrompt: effectivePrompt,
          hasVideoLoaded: Boolean(activeSource && activeClip),
          sourceVideoName: activeSource?.name,
          sourceDuration: activeSource?.duration,
          currentFrameDataUrl,
          audioBase64: extractedAudio?.wavBase64 || undefined,
          audioMimeType: extractedAudio?.wavBase64 ? 'audio/wav' : undefined,
          audioStartOffset: extractedAudio?.startClipTime,
          audioDuration: extractedAudio?.extractedDuration,
          transcriptExcerpt: transcriptSource.slice(0, 180).map((s) => ({
            start: s.start,
            end: s.end,
            text: s.text,
          })),
          attachments: attachmentsToSend.map((a) => ({
            name: a.name,
            mimeType: a.mimeType,
            kind: a.kind,
            dataUrl: a.dataUrl,
            videoFramesDataUrls: a.videoFramesDataUrls,
            textContent: a.textContent,
          })),
          timelineMode,
          inMarker,
          outMarker,
          focusLocksCount,
          generatedClipsList: generatedClips.map((c, idx) => ({
            index: idx + 1,
            id: c.id,
            name: c.name,
            duration: c.duration,
            sourceStart: c.sourceStart,
            sourceEnd: c.sourceEnd,
            commonThread: c.commonThread,
          })),
          activeScheme: {
            id: activeScheme.id,
            name: activeScheme.name,
            clipCreationMode: activeScheme.clipCreationMode,
            targetClipDuration: activeScheme.targetClipDuration,
            minClipDuration: activeScheme.minClipDuration,
            maxClipDuration: activeScheme.maxClipDuration,
            maxClipsCount: activeScheme.maxClipsCount,
            targetAvgShotLength: activeScheme.targetAvgShotLength,
            pacingProfile: activeScheme.pacingProfile,
            trackingMode: activeScheme.trackingMode,
            captionStyle: activeScheme.captionStyle,
            safeZoneGuide: activeScheme.safeZoneGuide,
            punchInZoom: activeScheme.punchInZoom,
            trackingSmoothing: activeScheme.trackingSmoothing,
          },
          activeClip: activeClip
            ? {
                id: activeClip.id,
                name: activeClip.name,
                sourceStart: activeClip.sourceStart,
                sourceEnd: activeClip.sourceEnd,
                duration: activeClip.duration,
                trackingMode: activeClip.trackingMode,
                trackingOffsetX: activeClip.trackingOffsetX,
                trackingSmoothing: activeClip.trackingSmoothing,
                zoomScale: currentZoom,
                backgroundFillStyle: activeClip.backgroundFillStyle,
                captionText: activeClip.captionText,
                captionStyle: activeClip.captionStyle,
                captionFontFamily: activeClip.captionFontFamily,
                captionPositionY: activeClip.captionPositionY ?? 0.77,
                captionPositionX: activeClip.captionPositionX ?? 0.5,
                captionFontScale: activeClip.captionFontScale ?? 1.0,
                captionTextColor: activeClip.captionTextColor,
                captionHighlightColor: activeClip.captionHighlightColor,
                captionBgOpacity: activeClip.captionBgOpacity,
                hideCaptions: activeClip.hideCaptions,
                overlayBannerText: activeClip.overlayBannerText,
                videoFilter: activeClip.videoFilter as any,
                subjectFocusLabel: activeClip.subjectFocus?.label,
                cuts: activeClip.subCuts.map((c) => ({
                  id: c.id,
                  timeOffset: c.timelineStart,
                  sourceStart: c.sourceStart,
                  sourceEnd: c.sourceEnd,
                  label: c.label,
                  zoom: c.zoom,
                  cropCenterX: c.cropBiasX,
                })),
              }
            : null,
          currentPlayhead: clipPlayheadTime,
          sourcePlayhead: playheadTime,
          schemeName: activeScheme.name,
        }),
      });

      const data = await resp.json();
      const operations = Array.isArray(data.operations) ? data.operations : [];
      const badges: string[] = [];

      // Helper to parse zoom value resiliently from any AI operation field
      const parseOpZoom = (op: any): number | null => {
        const raw = op?.zoom ?? op?.punchInZoom ?? op?.zoomScale ?? op?.scale ?? op?.level;
        if (typeof raw === 'number' && Number.isFinite(raw)) {
          if (raw > 10 && raw <= 200) return Number((raw / 100).toFixed(2));
          if (raw === 0) return 1.0;
          return Number(Math.max(0.55, Math.min(1.5, raw)).toFixed(2));
        }
        if (typeof raw === 'string') {
          const pctMatch = raw.match(/(\d+(?:\.\d+)?)\s*%/);
          if (pctMatch) {
            return Number(Math.max(0.55, Math.min(1.5, parseFloat(pctMatch[1]) / 100)).toFixed(2));
          }
          const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
          if (numMatch) {
            const v = parseFloat(numMatch[1]);
            if (v === 0) return 1.0;
            return Number(Math.max(0.55, Math.min(1.5, v)).toFixed(2));
          }
        }
        return null;
      };

      // Direct client-side intent detection for zoom removal / reset / fit-width so user commands NEVER fail
      const lowerPrompt = effectivePrompt.toLowerCase();
      const wantsFitWidth =
        /\b(fit\s+(the\s+)?(whole|full|entire)\s+(frame|width|video|shot)|letterbox|0\.56x?)\b/i.test(
          lowerPrompt
        );
      const wantsNoZoom =
        !wantsFitWidth &&
        (/\b(remove\s+(all\s+)?(the\s+)?zooms?|all\s+(the\s+)?zooms?\s+(removed|out|off)|zooms?\s+(all\s+)?(the\s+way\s+)?out|no\s+zooms?|without\s+zoom|reset\s+(all\s+)?(timeline\s+)?zooms?|100%\s+(the\s+whole\s+way|zoom)|1\.00?x|stop\s+zooming|clear\s+(all\s+)?zooms?)\b/i.test(
          lowerPrompt
        ) ||
          (currentZoom > 1.01 &&
            /\b(why\s+is\s+it\s+still\s+there|still\s+zoomed|still\s+1\.2)\b/i.test(lowerPrompt)));

      let targetGlobalZoom: number | null = wantsFitWidth ? 0.56 : wantsNoZoom ? 1.0 : null;

      // 1. Handle Scheme Updates
      let schemeAfterOps = { ...activeScheme };
      let schemeChanged = false;
      for (const op of operations) {
        const parsedZ = parseOpZoom(op);
        if (parsedZ !== null && (op.type === 'set_zoom' || op.type === 'update_scheme')) {
          targetGlobalZoom = parsedZ;
        }
        if (op.type === 'update_scheme' || op.type === 'generate_edited_clips') {
          if (typeof op.clipsCount === 'number') {
            schemeAfterOps.maxClipsCount = Math.max(1, Math.min(12, op.clipsCount));
            schemeChanged = true;
          }
          if (typeof op.targetDuration === 'number') {
            schemeAfterOps.targetClipDuration = Math.max(5, Math.min(180, op.targetDuration));
            schemeChanged = true;
          }
          if (op.clipMode === 'condensed-edit' || op.clipMode === 'clip-segment') {
            schemeAfterOps.clipCreationMode = op.clipMode;
            schemeChanged = true;
          }
          if (typeof op.avgShotLength === 'number') {
            schemeAfterOps.targetAvgShotLength = Math.max(0.8, Math.min(15, op.avgShotLength));
            schemeChanged = true;
          }
          if (op.pacingProfile) {
            schemeAfterOps.pacingProfile = op.pacingProfile;
            schemeChanged = true;
          }
          if (op.trackingMode) {
            schemeAfterOps.trackingMode = op.trackingMode;
            schemeChanged = true;
          }
          if (op.captionStyle) {
            schemeAfterOps.captionStyle = op.captionStyle;
            schemeChanged = true;
          }
          if (op.safeZoneGuide) {
            schemeAfterOps.safeZoneGuide = op.safeZoneGuide;
            schemeChanged = true;
          }
          if (parsedZ !== null) {
            schemeAfterOps.punchInZoom = Math.max(1.0, Math.min(1.5, parsedZ));
            schemeChanged = true;
          }
          if (typeof op.smoothing === 'number') {
            schemeAfterOps.trackingSmoothing = Math.max(0.15, Math.min(0.96, op.smoothing));
            schemeChanged = true;
          }
          if (op.type === 'update_scheme') {
            badges.push(op.summary || 'Updated Scheme');
          }
        }
      }
      if (targetGlobalZoom !== null && targetGlobalZoom <= 1.0) {
        schemeAfterOps.punchInZoom = 1.0;
        schemeChanged = true;
      }
      if (schemeChanged) {
        setActiveScheme(schemeAfterOps);
      }

      // Immediately apply global zoom change across fullVideoClip and all generatedClips so no subCut stays at 1.20x!
      if (targetGlobalZoom !== null) {
        applyZoomAcrossStudio(targetGlobalZoom, true);
        if (
          !operations.some((op: any) => op.type === 'set_zoom' || op.type === 'update_scheme')
        ) {
          badges.push(
            targetGlobalZoom === 1.0
              ? 'Removed All Zoom (1.00x Across All Cuts)'
              : `Set Timeline Zoom: ${targetGlobalZoom.toFixed(2)}x`
          );
        }
      }

      // 2. Handle Multimodal Clip Generation & Transcript Search Clipping
      const genClipsOp = operations.find((op: any) => op.type === 'generate_edited_clips');
      if (genClipsOp && activeSource) {
        const nextMode: ClipCreationMode =
          genClipsOp.clipMode || schemeAfterOps.clipCreationMode || 'condensed-edit';
        badges.push(
          genClipsOp.summary ||
            `Generated ${schemeAfterOps.maxClipsCount} ${
              nextMode === 'condensed-edit' ? 'Compilations' : 'Viral Clips'
            } (${schemeAfterOps.targetClipDuration}s)`
        );
        handleGenerateClipsFromFullVideo(
          nextMode,
          schemeAfterOps,
          genClipsOp.editorialFocusPrompt
        );
      }

      const searchTranscriptOp = operations.find(
        (op: any) => op.type === 'search_transcript_and_clip' && op.searchQuery
      );
      if (searchTranscriptOp && activeSource) {
        const q = String(searchTranscriptOp.searchQuery).toLowerCase();
        const segs = activeSource.transcriptSegments || activeClip?.captions || [];
        const matchIdx = segs.findIndex((s) => s.text.toLowerCase().includes(q));
        if (matchIdx >= 0) {
          const hit = segs[matchIdx];
          const inPt = Math.max(0, Number((hit.start - 1.5).toFixed(2)));
          const outPt = Math.min(
            activeSource.duration,
            Number((hit.start + Math.max(20, activeScheme.targetClipDuration || 30)).toFixed(2))
          );
          setInMarker(inPt);
          setOutMarker(outPt);
          handleSeekSourceTime(hit.start);
          badges.push(
            searchTranscriptOp.summary || `Found "${searchTranscriptOp.searchQuery}" @ ${hit.start.toFixed(1)}s`
          );
          if (searchTranscriptOp.extractClip) {
            setTimeout(() => {
              handleCreateClipFromMarkers(true, false);
            }, 60);
          }
        }
      }

      // 3. Handle Vision Focus Lock Point Placement (set_focus_point)
      for (const op of operations) {
        if (
          op.type === 'set_focus_point' &&
          typeof op.focusX === 'number' &&
          typeof op.focusY === 'number' &&
          activeClip
        ) {
          applyFocusLockAtNormalizedPoint(op.focusX, op.focusY, true, op.targetLabel);
          badges.push(
            op.summary ||
              `Locked: ${op.targetLabel || 'Object'} (${Math.round(op.focusX * 100)}%, ${Math.round(op.focusY * 100)}%)`
          );
        } else if (op.type === 'clear_focus_points' && activeClip) {
          handleSelectSubjectFocusStrategy('auto-salient');
          badges.push(op.summary || 'Cleared Focus Locks');
        } else if (op.type === 'set_in_out_markers' && activeSource) {
          if (typeof op.inPoint === 'number') {
            setInMarker(Math.max(0, Math.min(activeSource.duration - 0.5, op.inPoint)));
          }
          if (typeof op.outPoint === 'number') {
            setOutMarker(Math.max(0.5, Math.min(activeSource.duration, op.outPoint)));
          }
          if (op.extractClip) {
            setTimeout(() => {
              handleCreateClipFromMarkers(true, op.clipMode === 'condensed-edit');
            }, 60);
          }
          badges.push(op.summary || 'Updated In/Out Markers');
        } else if (op.type === 'select_clip' && activeSource) {
          if (op.targetView === 'full-source') {
            selectFullVideoOnTimeline();
            badges.push(op.summary || 'Switched to Full Video');
          } else if (typeof op.clipIndex === 'number') {
            const target = generatedClips[op.clipIndex - 1];
            if (target) {
              selectClip(target);
              badges.push(op.summary || `Selected Clip #${op.clipIndex}`);
            }
          }
        } else if (op.type === 'seek_playhead' && typeof op.targetTime === 'number' && activeClip) {
          const clamped = Math.max(0, Math.min(activeClip.duration, op.targetTime));
          const { sourceTime, cutIndex } = clipTimeToSourceTime(activeClip, clamped);
          activeCutIdxRef.current = Math.max(0, cutIndex);
          setSelectedCutIndex(Math.max(0, cutIndex));
          setClipPlayheadTime(clamped);
          setPlayheadTime(sourceTime);
          if (videoRef.current) {
            videoRef.current.currentTime = sourceTime;
          }
          badges.push(op.summary || `Seek → ${clamped.toFixed(1)}s`);
        } else if (op.type === 'playback_control' && activeClip && videoRef.current) {
          if (op.playbackAction === 'pause') {
            videoRef.current.pause();
            setIsPlaying(false);
          } else if (op.playbackAction === 'play') {
            if (!isPlaying) handleTogglePlay(false);
          } else if (op.playbackAction === 'loop_in_out') {
            handleTogglePlay(true);
          }
          badges.push(op.summary || `Playback: ${op.playbackAction}`);
        } else if (op.type === 'delete_current_cut' && activeClip) {
          handleDeleteSelectedCut();
          badges.push(op.summary || 'Deleted Sub-Cut');
        } else if (op.type === 'export_mp4' && activeClip) {
          badges.push(op.summary || 'Exporting 9:16 MP4');
          setTimeout(() => {
            handleExport();
          }, 100);
        } else if (op.type === 'save_project' && activeSource) {
          handleSaveCurrentProject(op.projectName);
          badges.push(op.summary || 'Saved Project');
        }
      }

      // 4. Handle Active Clip Timeline Mutations & AI Video Editor Skills
      const clipOps = operations.filter((op: any) =>
        [
          'customize_captions',
          'set_title_banner',
          'set_video_filter',
          'trim_start',
          'trim_end',
          'adjust_tracking_offset',
          'center_subject',
          'adjust_smoothing',
          'set_zoom',
          'repace_cuts',
          'update_caption',
          'strip_silence',
          'beat_sync_cuts',
          'set_layout_mode',
          'generate_word_captions',
          'set_playback_speed',
          'save_scheme_preset',
        ].includes(op.type)
      );

      // If Gemini emitted update_scheme with captionStyle, also propagate it to activeClip via customize_captions
      for (const op of operations) {
        if (op.type === 'update_scheme' && op.captionStyle) {
          clipOps.push({
            type: 'customize_captions',
            captionStyle: op.captionStyle,
            summary: `Caption Style: ${op.captionStyle}`,
          });
        }
      }

      // Direct client-side intent detection for Caption Position, Font, Size, Color & Box so user commands NEVER fail!
      const wantsCaptionTop =
        /\b(caption|captions|subtitle|subtitles|text|words?).*\b(top|upper|header)\b|\b(move|put|place).*\b(caption|captions|subtitle|subtitles|bar|text).*\b(top|up)\b/i.test(
          lowerPrompt
        );
      const wantsCaptionMiddle =
        !wantsCaptionTop &&
        /\b(caption|captions|subtitle|subtitles|bar|text).*\b(middle|center)\b|\b(move|put|place).*\b(caption|captions|subtitle|subtitles|bar|text).*\b(middle|center)\b/i.test(
          lowerPrompt
        );
      const wantsCaptionBottom =
        !wantsCaptionTop &&
        !wantsCaptionMiddle &&
        /\b(caption|captions|subtitle|subtitles|bar|text).*\b(bottom|lower)\b|\b(move|put|place).*\b(caption|captions|subtitle|subtitles|bar|text).*\b(bottom|down|lower)\b/i.test(
          lowerPrompt
        );

      const wantsGraffiti = /\b(graffiti|street\s*art|spray\s*paint|tag\s+font)\b/i.test(lowerPrompt);
      const wantsMarker = /\b(marker|sharpie|handwritten)\b/i.test(lowerPrompt);
      const wantsComic = /\b(comic|bangers|cartoon\s+font)\b/i.test(lowerPrompt);
      const wantsImpact = /\b(impact|anton|heavy\s+block)\b/i.test(lowerPrompt);
      const wantsBebas = /\b(bebas|tall\s+font)\b/i.test(lowerPrompt);
      const wantsSerif = /\b(serif|cinema\s+font|luxury\s+font|playfair)\b/i.test(lowerPrompt);
      const wantsMono = /\b(mono|monospace|typewriter|code\s+font)\b/i.test(lowerPrompt);

      const wantsBiggerCaptions = /\b(bigger|larger|increase)\s+(caption|captions|font|text)|\b(caption|captions|font|text)\s+(bigger|larger|huge)\b/i.test(lowerPrompt);
      const wantsSmallerCaptions = /\b(smaller|tiny|decrease)\s+(caption|captions|font|text)|\b(caption|captions|font|text)\s+(smaller)\b/i.test(lowerPrompt);
      const wantsNoCaptionBox = /\b(remove|no|hide|without)\s+(the\s+)?(caption\s+)?(background|box|bar|backing)\b/i.test(lowerPrompt);
      const wantsHideCaptions = /\b(hide|turn\s+off|remove)\s+(all\s+)?(the\s+)?(captions?|subtitles?)\b/i.test(lowerPrompt) && !wantsNoCaptionBox;
      const wantsShowCaptions = /\b(show|turn\s+on|enable)\s+(the\s+)?(captions?|subtitles?)\b/i.test(lowerPrompt);

      const detectedFontFamily = wantsGraffiti
        ? 'graffiti'
        : wantsMarker
          ? 'marker'
          : wantsComic
            ? 'bangers'
            : wantsImpact
              ? 'impact'
              : wantsBebas
                ? 'bebas'
                : wantsSerif
                  ? 'serif'
                  : wantsMono
                    ? 'mono'
                    : undefined;

      if (
        wantsCaptionTop ||
        wantsCaptionMiddle ||
        wantsCaptionBottom ||
        detectedFontFamily ||
        wantsBiggerCaptions ||
        wantsSmallerCaptions ||
        wantsNoCaptionBox ||
        wantsHideCaptions ||
        wantsShowCaptions
      ) {
        // Ensure a customize_captions operation merges with or supplements whatever the AI returned
        const existingCapOp = clipOps.find((o: any) => o.type === 'customize_captions');
        const targetPosY = wantsCaptionTop
          ? 0.14
          : wantsCaptionMiddle
            ? 0.5
            : wantsCaptionBottom
              ? 0.77
              : undefined;
        const summaryParts: string[] = [];
        if (wantsCaptionTop) summaryParts.push('Caption Bar → Top');
        if (wantsCaptionMiddle) summaryParts.push('Caption Bar → Middle');
        if (wantsCaptionBottom) summaryParts.push('Caption Bar → Bottom');
        if (detectedFontFamily) summaryParts.push(`Font: ${detectedFontFamily.toUpperCase()}`);
        if (wantsBiggerCaptions) summaryParts.push('Font Size +25%');
        if (wantsSmallerCaptions) summaryParts.push('Font Size -20%');
        if (wantsNoCaptionBox) summaryParts.push('Removed Caption Background Box');
        if (wantsHideCaptions) summaryParts.push('Hidden Captions');
        if (wantsShowCaptions) summaryParts.push('Shown Captions');

        if (existingCapOp) {
          if (targetPosY !== undefined && existingCapOp.captionPositionY === undefined) {
            existingCapOp.captionPositionY = targetPosY;
          }
          if (detectedFontFamily && !existingCapOp.captionFontFamily) {
            existingCapOp.captionFontFamily = detectedFontFamily;
            if (detectedFontFamily === 'graffiti') existingCapOp.captionStyle = 'street-graffiti';
          }
          if (wantsBiggerCaptions && !existingCapOp.captionFontScale) existingCapOp.captionFontScale = 1.28;
          if (wantsSmallerCaptions && !existingCapOp.captionFontScale) existingCapOp.captionFontScale = 0.8;
          if (wantsNoCaptionBox) existingCapOp.captionBgOpacity = 0;
          if (wantsHideCaptions) existingCapOp.hideCaptions = true;
          if (wantsShowCaptions) existingCapOp.hideCaptions = false;
        } else {
          clipOps.push({
            type: 'customize_captions',
            captionPositionY: targetPosY,
            captionFontFamily: detectedFontFamily,
            captionStyle: detectedFontFamily === 'graffiti' ? 'street-graffiti' : undefined,
            captionFontScale: wantsBiggerCaptions ? 1.28 : wantsSmallerCaptions ? 0.8 : undefined,
            captionBgOpacity: wantsNoCaptionBox ? 0 : undefined,
            hideCaptions: wantsHideCaptions ? true : wantsShowCaptions ? false : undefined,
            summary: summaryParts.join(' • ') || 'Updated Caption Style & Placement',
          });
        }
      }

      // Direct client-side intent detection for AI Video Editing Skills so natural-language commands always fire
      const wantsStripSilence =
        !clipOps.some((o: any) => o.type === 'strip_silence') &&
        /\b(strip\s+silence|remove\s+(all\s+)?(dead\s+air|silence|pauses)|cut\s+out\s+(the\s+)?(pauses|silence|dead\s+air)|jump[\s-]cut)\b/i.test(
          lowerPrompt
        );
      if (wantsStripSilence) {
        clipOps.push({
          type: 'strip_silence',
          silenceThreshold: 0.18,
          summary: 'Stripped Dead Air & Silent Pauses',
        });
      }

      const wantsSplitScreen =
        !clipOps.some((o: any) => o.type === 'set_layout_mode') &&
        /\b(split[\s-]screen|top\s+(and|&)\s+bottom|2[\s-]speaker\s+top|both\s+speakers\s+stacked)\b/i.test(
          lowerPrompt
        );
      const wantsAutoSwitchSpeakers =
        !wantsSplitScreen &&
        !clipOps.some((o: any) => o.type === 'set_layout_mode') &&
        /\b(auto[\s-]switch|switch\s+between\s+(left|both|the)\s+.*speakers|alternate\s+speakers)\b/i.test(
          lowerPrompt
        );
      const wantsBlurredBg =
        !wantsSplitScreen &&
        !wantsAutoSwitchSpeakers &&
        !clipOps.some((o: any) => o.type === 'set_layout_mode') &&
        /\b(blurred\s+(9:16\s+)?background|blur\s+fill|fill\s+black\s+bars)\b/i.test(lowerPrompt);

      if (wantsSplitScreen) {
        clipOps.push({
          type: 'set_layout_mode',
          layoutMode: 'split-screen',
          summary: '9:16 Top/Bottom Split-Screen',
        });
      } else if (wantsAutoSwitchSpeakers) {
        clipOps.push({
          type: 'set_layout_mode',
          layoutMode: 'auto-switch',
          summary: '2-Speaker Auto Camera Switch',
        });
      } else if (wantsBlurredBg) {
        clipOps.push({
          type: 'set_layout_mode',
          layoutMode: 'blurred',
          zoom: 0.56,
          summary: 'Fit 16:9 + Blurred 9:16 Background',
        });
      }

      const wantsBeatSync =
        !clipOps.some((o: any) => o.type === 'beat_sync_cuts') &&
        /\b(sync\s+cuts?\s+to\s+(audio\s+)?beats?|cut\s+to\s+the\s+beat|beat[\s-]sync)\b/i.test(
          lowerPrompt
        );
      if (wantsBeatSync) {
        clipOps.push({
          type: 'beat_sync_cuts',
          summary: 'Beat-Synced Cuts to Audio Peaks',
        });
      }

      const wantsWordCaptions =
        !clipOps.some((o: any) => o.type === 'generate_word_captions') &&
        /\b(word[\s-]by[\s-]word|karaoke\s+captions?|word[\s-]level\s+captions?|hormozi\s+captions?|transcribe\s+this)\b/i.test(
          lowerPrompt
        );
      if (wantsWordCaptions) {
        clipOps.push({
          type: 'generate_word_captions',
          captionStyle: lowerPrompt.includes('neon') ? 'neon-karaoke' : 'hormozi-bold',
          summary: 'Word-Level Karaoke Captions',
        });
      }

      if ((clipOps.length > 0 || targetGlobalZoom !== null) && activeClip && activeSource) {
        updateActiveTimelineClip((clip) => {
          let next = { ...clip, subCuts: [...clip.subCuts] };

          if (targetGlobalZoom !== null) {
            next.zoomScale = targetGlobalZoom;
            next.subCuts = next.subCuts.map((c) => ({ ...c, zoom: targetGlobalZoom! }));
          }

          for (const op of clipOps) {
            badges.push(op.summary || op.type);

            if (op.type === 'trim_start' && typeof op.deltaSeconds === 'number') {
              if (next.subCuts.length > 0) {
                const first = next.subCuts[0];
                const newStart = Number(
                  Math.max(
                    0,
                    Math.min(first.sourceEnd - 0.5, first.sourceStart + op.deltaSeconds)
                  ).toFixed(2)
                );
                next.subCuts[0] = { ...first, sourceStart: newStart };
                const recalc = recalculateClipTimeline(next.subCuts);
                next.subCuts = recalc.subCuts;
                next.duration = recalc.duration;
                next.sourceStart = recalc.sourceStart;
                next.sourceEnd = recalc.sourceEnd;
              }
            } else if (op.type === 'trim_end' && typeof op.deltaSeconds === 'number') {
              if (next.subCuts.length > 0) {
                const lastIdx = next.subCuts.length - 1;
                const last = next.subCuts[lastIdx];
                const newEnd = Number(
                  Math.min(
                    activeSource.duration,
                    Math.max(last.sourceStart + 0.5, last.sourceEnd + op.deltaSeconds)
                  ).toFixed(2)
                );
                next.subCuts[lastIdx] = { ...last, sourceEnd: newEnd };
                const recalc = recalculateClipTimeline(next.subCuts);
                next.subCuts = recalc.subCuts;
                next.duration = recalc.duration;
                next.sourceStart = recalc.sourceStart;
                next.sourceEnd = recalc.sourceEnd;
              }
            } else if (op.type === 'adjust_tracking_offset' && typeof op.offsetX === 'number') {
              next.trackingOffsetX = Math.max(
                -0.35,
                Math.min(0.35, next.trackingOffsetX + op.offsetX)
              );
            } else if (op.type === 'center_subject') {
              const targetStrategy: SubjectFocusStrategy = op.strategy || 'auto-salient';
              next.trackingOffsetX = 0;
              next.manualKeyframes = [];
              next.subjectFocus = {
                strategy: targetStrategy,
                anchorX:
                  targetStrategy === 'left-subject'
                    ? 0.3
                    : targetStrategy === 'right-subject'
                      ? 0.7
                      : 0.5,
                anchorY: 0.48,
                anchorTime: playheadTime,
                label:
                  targetStrategy === 'face-speaker'
                    ? 'Auto Face / Speaker'
                    : targetStrategy === 'left-subject'
                      ? 'Left Subject Focus'
                      : targetStrategy === 'right-subject'
                        ? 'Right Subject Focus'
                        : targetStrategy === 'action-motion'
                          ? 'Action / Motion Focus'
                          : 'Auto Salient Subject',
              };
            } else if (op.type === 'adjust_smoothing' && typeof op.smoothing === 'number') {
              next.trackingSmoothing = Math.max(0.15, Math.min(0.96, op.smoothing));
            } else if (op.type === 'set_zoom') {
              const parsed = parseOpZoom(op) ?? targetGlobalZoom ?? 1.0;
              const z = Math.max(0.55, Math.min(1.5, parsed));
              next.zoomScale = z;
              next.subCuts = next.subCuts.map((c) => ({ ...c, zoom: z }));
            } else if (op.type === 'strip_silence') {
              const res = stripSilenceFromClip(
                next,
                activeSource,
                typeof op.silenceThreshold === 'number' ? op.silenceThreshold : 0.18
              );
              next = res.updatedClip;
            } else if (op.type === 'beat_sync_cuts') {
              const res = snapCutsToAudioBeats(next, activeSource);
              next = res.updatedClip;
            } else if (op.type === 'set_layout_mode') {
              const mode = op.layoutMode || 'blurred';
              next = applyTwoSpeakerEditMode(next, activeSource, mode);
              if (typeof op.zoom === 'number') {
                const z = Math.max(0.55, Math.min(1.5, op.zoom));
                next.zoomScale = z;
                next.subCuts = next.subCuts.map((c) => ({ ...c, zoom: z }));
              }
            } else if (op.type === 'customize_captions') {
              if (op.captionPosition === 'top') next.captionPositionY = 0.14;
              else if (op.captionPosition === 'middle') next.captionPositionY = 0.5;
              else if (op.captionPosition === 'bottom') next.captionPositionY = 0.77;
              if (typeof op.captionPositionY === 'number') {
                next.captionPositionY = Math.max(0.08, Math.min(0.92, op.captionPositionY));
              }
              if (typeof op.captionPositionX === 'number') {
                next.captionPositionX = Math.max(0.18, Math.min(0.82, op.captionPositionX));
              }
              if (op.captionFontFamily) {
                next.captionFontFamily = op.captionFontFamily;
              }
              if (op.captionStyle) {
                next.captionStyle = op.captionStyle;
              }
              if (typeof op.captionFontScale === 'number') {
                next.captionFontScale = Math.max(0.5, Math.min(2.2, op.captionFontScale));
              }
              if (op.captionTextColor) {
                next.captionTextColor = op.captionTextColor;
              }
              if (op.captionHighlightColor) {
                next.captionHighlightColor = op.captionHighlightColor;
              }
              if (op.captionBgColor) {
                next.captionBgColor = op.captionBgColor;
              }
              if (typeof op.captionBgOpacity === 'number') {
                next.captionBgOpacity = Math.max(0, Math.min(1, op.captionBgOpacity));
              }
              if (typeof op.captionUppercase === 'boolean') {
                next.captionUppercase = op.captionUppercase;
              }
              if (typeof op.hideCaptions === 'boolean') {
                next.hideCaptions = op.hideCaptions;
              }
            } else if (op.type === 'set_title_banner') {
              next.overlayBannerText = op.bannerText ?? '';
              if (typeof op.bannerPositionY === 'number') {
                next.overlayBannerPositionY = Math.max(0.06, Math.min(0.92, op.bannerPositionY));
              }
              if (op.bannerBgColor) next.overlayBannerBgColor = op.bannerBgColor;
              if (op.bannerTextColor) next.overlayBannerTextColor = op.bannerTextColor;
            } else if (op.type === 'set_video_filter') {
              next.videoFilter = {
                ...(next.videoFilter || {}),
                ...(typeof op.brightness === 'number' ? { brightness: op.brightness } : {}),
                ...(typeof op.contrast === 'number' ? { contrast: op.contrast } : {}),
                ...(typeof op.saturation === 'number' ? { saturation: op.saturation } : {}),
                ...(typeof op.grayscale === 'number' ? { grayscale: op.grayscale } : {}),
                ...(typeof op.sepia === 'number' ? { sepia: op.sepia } : {}),
                ...(typeof op.hueRotate === 'number' ? { hueRotate: op.hueRotate } : {}),
              };
            } else if (op.type === 'generate_word_captions') {
              if (op.captionStyle) {
                next.captionStyle = op.captionStyle;
              }
              if (op.captionFontFamily) {
                next.captionFontFamily = op.captionFontFamily;
              }
              if (op.captionPosition === 'top') next.captionPositionY = 0.14;
              else if (op.captionPosition === 'middle') next.captionPositionY = 0.5;
              else if (op.captionPosition === 'bottom') next.captionPositionY = 0.77;
              if (typeof op.captionPositionY === 'number') {
                next.captionPositionY = Math.max(0.08, Math.min(0.92, op.captionPositionY));
              }
              if (!isCaptionStyleOrPositionRequest && Array.isArray(op.captionSegments) && op.captionSegments.length > 0) {
                next.captions = buildWordLevelCaptionsFromText(
                  op.captionSegments.map((s: any, idx: number) => ({
                    id: `ai-wcap-${idx}-${Date.now()}`,
                    start: Number(s.start) || 0,
                    end: Number(s.end) || 2.0,
                    text: String(s.text || ''),
                  })),
                  next.duration,
                  4,
                  clipPlayheadTime
                );
                next.captionText = next.captions[0]?.text || next.captionText;
              } else if (!isCaptionStyleOrPositionRequest && op.captionText) {
                next.captions = buildWordLevelCaptionsFromText(
                  op.captionText,
                  next.duration,
                  4,
                  clipPlayheadTime
                );
                next.captionText = op.captionText;
              } else if (!isCaptionStyleOrPositionRequest || next.captions.length === 0) {
                // Trigger real audio transcription asynchronously only when captions are actually requested!
                setTimeout(() => {
                  handleRunAITranscription();
                }, 40);
              }
            } else if (op.type === 'set_playback_speed') {
              const spd = Math.max(0.5, Math.min(2.0, Number(op.speed) || 1.25));
              next.playbackSpeed = spd;
              next.subCuts = next.subCuts.map((c) => ({ ...c, speed: spd }));
              if (videoRef.current) {
                videoRef.current.playbackRate = spd;
              }
            } else if (op.type === 'repace_cuts' && typeof op.pacingMultiplier === 'number') {
              const newAsl = Math.max(
                0.8,
                Math.min(15.0, schemeAfterOps.targetAvgShotLength * op.pacingMultiplier)
              );
              const rebuilt: SubCut[] = [];
              for (const c of next.subCuts) {
                let cur = c.sourceStart;
                while (cur < c.sourceEnd - 0.3) {
                  const endT = Math.min(c.sourceEnd, Number((cur + newAsl).toFixed(2)));
                  rebuilt.push({
                    ...c,
                    id: `repace-${rebuilt.length + 1}-${Date.now()}`,
                    sourceStart: cur,
                    sourceEnd: endT,
                    zoom:
                      targetGlobalZoom !== null
                        ? targetGlobalZoom
                        : rebuilt.length % 2 === 1
                          ? next.zoomScale
                          : 1.0,
                  });
                  cur = endT;
                }
              }
              const recalc = recalculateClipTimeline(rebuilt);
              next.subCuts = recalc.subCuts;
              next.duration = recalc.duration;
            } else if (op.type === 'update_caption' && op.captionText !== undefined) {
              next.captionText = op.captionText;
              if (op.captionText.trim()) {
                next.captions = buildWordLevelCaptionsFromText(
                  op.captionText,
                  next.duration,
                  5
                );
              }
            } else if (op.type === 'save_scheme_preset') {
              const presetName = op.schemePresetName || `Custom ${schemeAfterOps.name}`;
              const saved: EditingScheme = {
                ...schemeAfterOps,
                id: `scheme-${Date.now()}`,
                name: presetName,
                isBuiltIn: false,
                createdAt: new Date().toISOString(),
                trackingSmoothing: next.trackingSmoothing,
                punchInZoom: next.zoomScale,
              };
              const nextList = [saved, ...schemes];
              setSchemes(nextList);
              saveSchemesToStorage(nextList);
              setActiveScheme(saved);
            }
          }
          return next;
        });

        // Also propagate global caption styling/position updates across all generated clips & fullVideoClip
        const capStylingOps = clipOps.filter((o: any) => o.type === 'customize_captions');
        if (capStylingOps.length > 0) {
          const applyCapPatch = (c: GeneratedClip): GeneratedClip => {
            let patched = { ...c };
            for (const op of capStylingOps) {
              if (op.captionPosition === 'top') patched.captionPositionY = 0.14;
              else if (op.captionPosition === 'middle') patched.captionPositionY = 0.5;
              else if (op.captionPosition === 'bottom') patched.captionPositionY = 0.77;
              if (typeof op.captionPositionY === 'number') {
                patched.captionPositionY = Math.max(0.08, Math.min(0.92, op.captionPositionY));
              }
              if (typeof op.captionPositionX === 'number') {
                patched.captionPositionX = Math.max(0.18, Math.min(0.82, op.captionPositionX));
              }
              if (op.captionFontFamily) patched.captionFontFamily = op.captionFontFamily;
              if (op.captionStyle) patched.captionStyle = op.captionStyle;
              if (typeof op.captionFontScale === 'number') {
                patched.captionFontScale = Math.max(0.5, Math.min(2.2, op.captionFontScale));
              }
              if (op.captionTextColor) patched.captionTextColor = op.captionTextColor;
              if (op.captionHighlightColor) patched.captionHighlightColor = op.captionHighlightColor;
              if (op.captionBgColor) patched.captionBgColor = op.captionBgColor;
              if (typeof op.captionBgOpacity === 'number') {
                patched.captionBgOpacity = Math.max(0, Math.min(1, op.captionBgOpacity));
              }
              if (typeof op.captionUppercase === 'boolean') {
                patched.captionUppercase = op.captionUppercase;
              }
              if (typeof op.hideCaptions === 'boolean') {
                patched.hideCaptions = op.hideCaptions;
              }
            }
            return patched;
          };
          setFullVideoClip((prev) => (prev ? applyCapPatch(prev) : prev));
          setGeneratedClips((prev) => prev.map(applyCapPatch));
        }
      }

      if (operations.some((o: any) => o.type === 'split_at_playhead') && activeClip) {
        handleSplitAtPlayhead();
        badges.push(`Razor Cut @ ${clipPlayheadTime.toFixed(1)}s`);
      }

      if (preEditSnapshot && badges.length > 0) {
        preEditSnapshot.summaryBadges = badges;
        setRevisions((prev) => [preEditSnapshot, ...prev]);
      }

      setChatMessages((prev) => [
        ...prev,
        {
          id: `ast-${Date.now()}`,
          role: 'assistant',
          content: data.reply || 'Applied requested Studio actions.',
          timestamp: new Date().toISOString(),
          playheadTime: clipPlayheadTime,
          providerBadge: data.liveApiUsed
            ? `${data.modelUsed || data.providerUsed} [Live]`
            : `${data.providerUsed} Engine`,
          operationBadges: badges,
          revisionSnapshotId: preEditSnapshot && badges.length > 0 ? snapshotId : undefined,
        },
      ]);
    } catch (err: any) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `err-${Date.now()}`,
          role: 'assistant',
          content: `Error: ${err?.message || 'Could not apply edit'}`,
          timestamp: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsCopilotBusy(false);
    }
  };

  const handleRevertSnapshot = (snapshotId: string) => {
    const snap = revisions.find((r) => r.id === snapshotId);
    if (!snap) return;
    if (snap.clipSnapshot.id === '__full_source__') {
      setFullVideoClip(snap.clipSnapshot);
    } else {
      setGeneratedClips((prev) =>
        prev.map((c) => (c.id === snap.clipSnapshot.id ? snap.clipSnapshot : c))
      );
    }
  };

  // Export 9:16 Video
  const handleExport = async () => {
    if (!activeSource || !activeClip || isExporting) return;
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    setIsExporting(true);
    setExportProgress(1);
    try {
      await exportClipTo9x16Video(activeSource, activeClip, (pct) => {
        setExportProgress(pct);
      });
    } catch (err: any) {
      alert(`Export error: ${err?.message || 'Failed to export video'}`);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  };

  // Helper to change Clip Mode ('clip-segment' vs 'condensed-edit') without auto-clipping until user clicks Generate
  const handleSelectClipMode = (mode: ClipCreationMode) => {
    const nextScheme: EditingScheme = { ...activeScheme, clipCreationMode: mode };
    setActiveScheme(nextScheme);
  };

  // Helper to change Number of Clips without auto-clipping until user clicks Generate
  const handleChangeClipsCount = (count: number) => {
    const clamped = Math.max(1, Math.min(12, count));
    setClipsCountTextInput(String(clamped));
    const nextScheme: EditingScheme = { ...activeScheme, maxClipsCount: clamped };
    setActiveScheme(nextScheme);
  };

  // Helper to change Target Clip Duration (5s .. 180s / 3 mins) without auto-clipping until user clicks Generate
  const handleApplyTargetDuration = (seconds: number, reCutNow = false) => {
    const clamped = Math.max(5, Math.min(180, Math.round(seconds)));
    setDurationTextInput(String(clamped));
    const nextScheme: EditingScheme = {
      ...activeScheme,
      targetClipDuration: clamped,
      maxClipDuration: 180,
    };
    setActiveScheme(nextScheme);
    if (reCutNow && activeSource && generatedClips.length > 0) {
      const currentFocus = activeClip?.subjectFocus;
      const fresh = generateClipsFromScheme(activeSource, nextScheme).map((c) =>
        currentFocus ? { ...c, subjectFocus: currentFocus } : c
      );
      setGeneratedClips(fresh);
      if (fresh[0]) {
        selectClip(fresh[0]);
      }
    }
  };

  // Pointer drag handler on the Timeline Bar
  const updateTimelineDragAtClientX = (
    clientX: number,
    handle: 'playhead' | 'in' | 'out'
  ) => {
    if (!timelineBarRef.current || !activeClip || !activeSource) return;
    const rect = timelineBarRef.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const timelineSec = ratio * activeClip.duration;
    const mappedSourceSec = Number(
      clipTimeToSourceTime(activeClip, timelineSec).sourceTime.toFixed(2)
    );

    if (handle === 'in') {
      const maxIn =
        outMarker !== null ? Math.max(0, outMarker - 0.5) : activeSource.duration - 0.5;
      const nextIn = Math.max(0, Math.min(maxIn, mappedSourceSec));
      setInMarker(Number(nextIn.toFixed(2)));
      handleSeekSourceTime(nextIn);
    } else if (handle === 'out') {
      const minOut =
        inMarker !== null ? Math.min(activeSource.duration, inMarker + 0.5) : 0.5;
      const nextOut = Math.max(minOut, Math.min(activeSource.duration, mappedSourceSec));
      setOutMarker(Number(nextOut.toFixed(2)));
      handleSeekSourceTime(nextOut);
    } else {
      handleSeekClipTime(timelineSec);
    }
  };

  const currentClipMode: ClipCreationMode = activeScheme.clipCreationMode || 'clip-segment';
  const inspectedCut =
    activeClip?.subCuts[Math.min(selectedCutIndex, (activeClip?.subCuts.length || 1) - 1)] ||
    activeCut;

  const activeFocusStrategy: SubjectFocusStrategy =
    activeClip?.subjectFocus?.strategy || 'auto-salient';

  // Compute In/Out Marker positions in % on the current timeline when visible
  const inMarkerTimelineSec =
    activeClip && inMarker !== null ? sourceTimeToClipTime(activeClip, inMarker) : null;
  const outMarkerTimelineSec =
    activeClip && outMarker !== null ? sourceTimeToClipTime(activeClip, outMarker) : null;
  const inMarkerPct =
    activeClip && inMarkerTimelineSec !== null
      ? Math.max(
          0,
          Math.min(100, (inMarkerTimelineSec / Math.max(0.1, activeClip.duration)) * 100)
        )
      : null;
  const outMarkerPct =
    activeClip && outMarkerTimelineSec !== null
      ? Math.max(
          0,
          Math.min(100, (outMarkerTimelineSec / Math.max(0.1, activeClip.duration)) * 100)
        )
      : null;
  const markedDuration =
    inMarker !== null && outMarker !== null
      ? Math.max(0, Number((outMarker - inMarker).toFixed(1)))
      : 0;

  // Enforce @complex.com Google OAuth authentication before accessing the studio
  if (!authUser) {
    return (
      <ComplexAuthGate
        serverAIStatus={serverAIStatus}
        onAuthenticated={(user) => setAuthUser(user)}
      />
    );
  }

  return (
    <Tooltip.Provider delayDuration={180}>
      <div className="studio-shell">
        {/* Hidden File Inputs */}
        <input
          ref={sourceFileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUploadVideoFile(f);
            e.target.value = '';
          }}
        />
        <input
          ref={referenceFileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleUploadReferenceVideo(f);
            e.target.value = '';
          }}
        />

        {/* Top Studio Bar */}
        <header className="studio-topbar">
          <div className="studio-brand">
            <div className="studio-brand-mark">
              <Scissors size={13} strokeWidth={2.2} />
            </div>
            <span style={{ fontWeight: 600, fontSize: 13, letterSpacing: '-0.02em' }}>
              ClipMaker
            </span>
            {activeSource && (
              <>
                <span style={{ color: 'var(--text-muted)' }}>/</span>
                <span
                  style={{
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    maxWidth: 180,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {currentProjectName}
                </span>
              </>
            )}
          </div>

          {/* Center Status Pill */}
          {(isAnalyzing || isCloningRef || markerNotice || schemeSavedNotice) && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                padding: '4px 11px',
                borderRadius: 5,
                color: 'var(--text-secondary)',
                fontSize: 11.5,
                maxWidth: 420,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: isAnalyzing || isCloningRef ? 'var(--accent-blue)' : '#10b981',
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {sanitizeCleanText(
                  analysisStatus || markerNotice || schemeSavedNotice || 'Processing...'
                )}
              </span>
            </div>
          )}

          {/* Right Studio Actions */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              className="btn"
              onClick={() => setIsProjectsModalOpen(true)}
              title="Saved projects"
            >
              <FolderOpen size={13} />
              Projects
            </button>

            {activeSource && (
              <button
                className="btn"
                onClick={() => handleSaveCurrentProject(currentProjectName, false)}
                disabled={isSavingProject}
                title="Save project"
              >
                <Save size={13} />
                {isSavingProject ? 'Saving' : 'Save'}
              </button>
            )}

            <div className="studio-divider-v" />

            <button
              className="btn"
              onClick={() => sourceFileInputRef.current?.click()}
              disabled={isAnalyzing}
            >
              <Upload size={13} />
              Upload
            </button>

            <button
              className="btn btn-danger"
              onClick={handleClearVideo}
              disabled={!activeSource || isAnalyzing}
              title="Clear video and reset workspace"
            >
              <Trash2 size={13} />
              Clear Video
            </button>

            <button
              className="btn btn-danger"
              onClick={handleClearAllClips}
              disabled={generatedClips.length === 0 || isGeneratingClips}
              title="Delete all generated clips"
            >
              <Trash2 size={13} />
              Delete Clips{generatedClips.length > 0 ? ` (${generatedClips.length})` : ''}
            </button>

            <button
              className="btn"
              onClick={() => referenceFileInputRef.current?.click()}
              disabled={isCloningRef}
              title="Clone editing style from reference video"
            >
              <Wand2 size={13} />
              Clone Style
            </button>

            <div className="studio-divider-v" />

            {/* Segmented AI Provider Selector */}
            <div className="seg-group">
              {(['gemini', 'claude', 'openai'] as AIProviderId[]).map((prov) => {
                const active = aiSettings.activeProvider === prov;
                const envReady =
                  (prov === 'gemini' && serverAIStatus.geminiConfigured) ||
                  (prov === 'claude' && serverAIStatus.claudeConfigured) ||
                  (prov === 'openai' && serverAIStatus.openaiConfigured) ||
                  Boolean(aiSettings.apiKeys?.[prov]);
                const label =
                  prov === 'gemini' ? 'Gemini' : prov === 'claude' ? 'Claude' : 'OpenAI';
                return (
                  <button
                    key={prov}
                    type="button"
                    className="seg-item"
                    data-active={active}
                    onClick={() => {
                      const updated = { ...aiSettings, activeProvider: prov };
                      setAiSettings(updated);
                      saveAISettings(updated);
                    }}
                  >
                    <span
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: '50%',
                        background: envReady ? '#10b981' : '#52525b',
                      }}
                    />
                    {label}
                  </button>
                );
              })}
              <button
                type="button"
                className="seg-item"
                style={{ padding: '0 6px' }}
                onClick={() => setIsAISettingsOpen(true)}
                title="AI Model & API Settings"
              >
                <Settings size={12} />
              </button>
            </div>

            <button
              className="btn btn-primary"
              onClick={handleExport}
              disabled={!activeSource || !activeClip || isExporting}
            >
              <Download size={13} />
              {isExporting ? `Exporting ${exportProgress}%` : 'Export MP4'}
            </button>

            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 28,
                padding: '0 8px',
                borderRadius: 5,
                background: 'var(--bg-input)',
                border: '1px solid var(--border-subtle)',
                fontSize: 11,
                color: 'var(--text-secondary)',
              }}
            >
              <span
                style={{
                  maxWidth: 110,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {authUser.email}
              </span>
              <button
                type="button"
                onClick={() => {
                  signOutComplexUser();
                  setAuthUser(null);
                }}
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--text-muted)',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                }}
                title="Sign out"
              >
                <LogOut size={12} />
              </button>
            </div>
          </div>
        </header>

        {/* Main 3-Column Resizable Workspace */}
        <main
          className="studio-workspace"
          style={{
            gridTemplateColumns: `${leftPanelWidth}px 5px 1fr 5px ${rightPanelWidth}px`,
            gap: 0,
          }}
        >
          {/* LEFT PANEL: Generator & Clips */}
          <aside className="studio-panel">
            <div className="studio-panel-header">
              <span>AI Clip & Compilation Generator</span>
              <button
                className="btn btn-sm"
                onClick={() => handleSaveAndApplyScheme(false)}
                title="Save preset"
              >
                <Save size={11} />
                Save Preset
              </button>
            </div>

            {/* Complete Generator Controls */}
            <div
              style={{
                padding: 10,
                borderBottom: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {/* Radix Tabs Segmented Mode Switcher */}
              <Tabs.Root
                value={currentClipMode}
                onValueChange={(v) => handleSelectClipMode(v as ClipCreationMode)}
              >
                <Tabs.List
                  className="seg-group"
                  style={{ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr' }}
                >
                  <Tabs.Trigger value="clip-segment" className="seg-item">
                    <Flame size={12} />
                    Best Viral Clips
                  </Tabs.Trigger>
                  <Tabs.Trigger value="condensed-edit" className="seg-item">
                    <Layers size={12} />
                    Compilations
                  </Tabs.Trigger>
                </Tabs.List>
              </Tabs.Root>

              {/* 3-Column Parameter Row: Duration, Count, Pace */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.9fr 0.9fr', gap: 6 }}>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      marginBottom: 3,
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>Duration</span>
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {formatDurationBadge(activeScheme.targetClipDuration)}
                    </span>
                  </div>
                  <input
                    type="text"
                    className="input-field input-mono"
                    value={durationTextInput}
                    onChange={(e) => {
                      const val = e.target.value;
                      setDurationTextInput(val);
                      const parsed = parseDurationTextToSeconds(
                        val,
                        activeScheme.targetClipDuration
                      );
                      setActiveScheme((prev) => ({
                        ...prev,
                        targetClipDuration: parsed,
                        maxClipDuration: 180,
                      }));
                    }}
                    onBlur={() => {
                      const parsed = parseDurationTextToSeconds(
                        durationTextInput,
                        activeScheme.targetClipDuration
                      );
                      handleApplyTargetDuration(parsed, false);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        const parsed = parseDurationTextToSeconds(
                          durationTextInput,
                          activeScheme.targetClipDuration
                        );
                        handleApplyTargetDuration(parsed, false);
                      }
                    }}
                  />
                </div>

                <div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      marginBottom: 3,
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>Clips</span>
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      1–12
                    </span>
                  </div>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    className="input-field input-mono"
                    value={clipsCountTextInput}
                    onChange={(e) => {
                      setClipsCountTextInput(e.target.value);
                      const n = parseInt(e.target.value, 10);
                      if (Number.isFinite(n) && n >= 1 && n <= 12) {
                        handleChangeClipsCount(n);
                      }
                    }}
                    onBlur={() => {
                      const n = parseInt(clipsCountTextInput, 10);
                      handleChangeClipsCount(Number.isFinite(n) ? n : activeScheme.maxClipsCount);
                    }}
                  />
                </div>

                <div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-secondary)',
                      marginBottom: 3,
                      display: 'flex',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span>Shot Pace</span>
                    <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                      {activeScheme.targetAvgShotLength}s
                    </span>
                  </div>
                  <input
                    type="number"
                    min={0.8}
                    max={15.0}
                    step={0.1}
                    className="input-field input-mono"
                    value={aslTextInput}
                    onChange={(e) => {
                      setAslTextInput(e.target.value);
                      const v = parseFloat(e.target.value);
                      if (Number.isFinite(v) && v >= 0.8 && v <= 15) {
                        setActiveScheme({
                          ...activeScheme,
                          targetAvgShotLength: Number(v.toFixed(1)),
                        });
                      }
                    }}
                  />
                </div>
              </div>

              {/* Clean Duration Slider + Quick Duration Presets */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input
                  type="range"
                  min={5}
                  max={180}
                  step={1}
                  value={activeScheme.targetClipDuration}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    setDurationTextInput(String(v));
                    setActiveScheme({
                      ...activeScheme,
                      targetClipDuration: v,
                      maxClipDuration: 180,
                    });
                  }}
                  onMouseUp={() => handleApplyTargetDuration(activeScheme.targetClipDuration, false)}
                  style={{ width: '100%' }}
                />
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 4 }}>
                  {[15, 30, 60, 90, 120, 180].map((sec) => {
                    const active = Math.abs(activeScheme.targetClipDuration - sec) <= 1;
                    return (
                      <button
                        key={sec}
                        type="button"
                        className={`btn btn-sm ${active ? 'btn-active' : ''}`}
                        style={{
                          height: 20,
                          padding: 0,
                          justifyContent: 'center',
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                        }}
                        onClick={() => handleApplyTargetDuration(sec, false)}
                      >
                        {sec}s
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Topic / Common Thread Input + Indexed Transcript Status */}
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 3,
                    fontSize: 10,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <span>Common Thread / Topic Filter</span>
                  {activeSource?.transcriptSegments && activeSource.transcriptSegments.length > 0 && (
                    <span className="badge-subtle">
                      {activeSource.transcriptSegments.length} phrases indexed
                    </span>
                  )}
                </div>
                <input
                  type="text"
                  className="input-field"
                  placeholder="Optional topic, quote, or speaker focus..."
                  value={editorialFocusInput}
                  onChange={(e) => setEditorialFocusInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && activeSource && !isGeneratingClips) {
                      e.preventDefault();
                      handleGenerateClipsFromFullVideo(currentClipMode);
                    }
                  }}
                />
              </div>

              {/* Generate Action */}
              <button
                className="btn btn-primary"
                style={{ width: '100%', height: 30, justifyContent: 'center' }}
                onClick={() => handleGenerateClipsFromFullVideo(currentClipMode)}
                disabled={!activeSource || isGeneratingClips}
              >
                <Sparkles size={13} />
                {isGeneratingClips
                  ? `Analyzing Transcript (${clipGenerationProgress}%)`
                  : currentClipMode === 'condensed-edit'
                    ? `Build ${activeScheme.maxClipsCount} Compilations (${activeScheme.targetClipDuration}s)`
                    : `Generate ${activeScheme.maxClipsCount} Viral Clips (${activeScheme.targetClipDuration}s)`}
              </button>

              {isGeneratingClips && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div
                    style={{
                      width: '100%',
                      height: 3,
                      borderRadius: 999,
                      background: 'var(--bg-input)',
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      style={{
                        width: `${Math.max(5, clipGenerationProgress)}%`,
                        height: '100%',
                        background: 'var(--text-main)',
                        transition: 'width 0.25s ease',
                      }}
                    />
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: 'var(--text-secondary)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {sanitizeCleanText(clipGenerationStage || 'Processing...')}
                  </div>
                </div>
              )}
            </div>

            {/* Sticky Clips Header with Always-Visible Clear Video & Delete Clips */}
            <div className="studio-panel-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span>Clips & Source</span>
                <span className="badge-subtle">{generatedClips.length}</span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={handleClearVideo}
                  disabled={!activeSource || isAnalyzing}
                  title="Clear video"
                >
                  <Trash2 size={11} />
                  Clear Video
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={handleClearAllClips}
                  disabled={generatedClips.length === 0 || isGeneratingClips}
                  title="Delete all clips"
                >
                  <Trash2 size={11} />
                  Delete Clips
                </button>
              </div>
            </div>

            {/* Clips & Source List */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 8,
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
              }}
            >
              {!activeSource ? (
                <div
                  style={{
                    padding: '28px 12px',
                    textAlign: 'center',
                    color: 'var(--text-muted)',
                    fontSize: 11.5,
                  }}
                >
                  No media loaded
                </div>
              ) : (
                <>
                  {/* Source Video Item with 1-Click Viral Clips & Compilation Actions */}
                  <div
                    className="clip-row"
                    data-selected={timelineMode === 'full-source'}
                    onClick={selectFullVideoOnTimeline}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 6,
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          fontWeight: 600,
                          fontSize: 12,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <Video size={13} color="var(--text-secondary)" style={{ flexShrink: 0 }} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {activeSource.name}
                        </span>
                      </span>

                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <span className="badge-subtle">Full Source</span>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          style={{ padding: '0 5px', height: 20 }}
                          onClick={handleClearVideo}
                          title="Clear video"
                        >
                          <Trash2 size={11} />
                        </button>
                      </div>
                    </div>

                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                        color: 'var(--text-muted)',
                        display: 'flex',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span>
                        {(fullVideoClip?.duration ?? activeSource.duration).toFixed(1)}s ·{' '}
                        {fullVideoClip?.subCuts.length || 1}{' '}
                        {(fullVideoClip?.subCuts.length || 1) === 1 ? 'cut' : 'cuts'}
                      </span>
                      <span>
                        {nativeDims.width}×{nativeDims.height}
                      </span>
                    </div>

                    {/* 1-Click Mode Actions directly on the Source Video Card */}
                    <div
                      style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5, marginTop: 2 }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ justifyContent: 'center' }}
                        disabled={isGeneratingClips}
                        onClick={() => handleGenerateClipsFromFullVideo('clip-segment')}
                      >
                        <Flame size={11} />
                        Viral Clips
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        style={{ justifyContent: 'center' }}
                        disabled={isGeneratingClips}
                        onClick={() => handleGenerateClipsFromFullVideo('condensed-edit')}
                      >
                        <Layers size={11} />
                        Compilation
                      </button>
                    </div>
                  </div>

                  {/* Generated Clips */}
                  {generatedClips.map((clip, index) => {
                    const selected =
                      timelineMode === 'elected-clip' && clip.id === selectedClipObj?.id;
                    const isEditMode = clip.clipCreationMode === 'condensed-edit';

                    return (
                      <div
                        key={clip.id}
                        className="clip-row"
                        data-selected={selected}
                        onClick={() => selectClip(clip)}
                      >
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <span
                            style={{
                              fontWeight: 500,
                              fontSize: 12,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {index + 1}. {clip.name}
                          </span>

                          <div
                            style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <span className="badge-subtle">
                              {isEditMode ? 'COMP' : 'CLIP'} · {clip.viralScore}%
                            </span>

                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              style={{ padding: '0 5px', height: 20 }}
                              onClick={(e) => handleDeleteSingleClip(clip.id, e)}
                              title="Delete clip"
                            >
                              <Trash2 size={11} />
                            </button>
                          </div>
                        </div>

                        <div
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 10.5,
                            color: 'var(--text-muted)',
                            display: 'flex',
                            justifyContent: 'space-between',
                          }}
                        >
                          <span>
                            {isEditMode
                              ? `${clip.subCuts.length} cuts · ${clip.duration.toFixed(1)}s`
                              : `${formatSMPTETimecode(clip.sourceStart).slice(3, 8)}–${formatSMPTETimecode(clip.sourceEnd).slice(3, 8)} · ${clip.duration.toFixed(1)}s`}
                          </span>
                          {clip.captions.length > 0 && <span>{clip.captions.length} caps</span>}
                        </div>

                        {clip.commonThread && (
                          <div
                            style={{
                              fontSize: 10.5,
                              color: 'var(--text-secondary)',
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            Thread: {sanitizeCleanText(clip.commonThread)}
                          </div>
                        )}

                        {clip.viralMechanics && clip.viralMechanics.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                            {clip.viralMechanics.slice(0, 3).map((m, mIdx) => (
                              <span
                                key={mIdx}
                                className="badge-subtle"
                                style={{ fontSize: 9.5, padding: '1px 4px' }}
                              >
                                {sanitizeCleanText(m)}
                              </span>
                            ))}
                          </div>
                        )}

                        {clip.hookReason && (
                          <div
                            style={{
                              fontSize: 10.5,
                              color: 'var(--text-muted)',
                              lineHeight: 1.35,
                              display: '-webkit-box',
                              WebkitLineClamp: 2,
                              WebkitBoxOrient: 'vertical',
                              overflow: 'hidden',
                            }}
                          >
                            {sanitizeCleanText(clip.hookReason)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </>
              )}
            </div>
          </aside>

          {/* Left Vertical Resize Splitter */}
          <div
            className="studio-splitter-v"
            data-dragging={resizingPane === 'left'}
            onMouseDown={(e) => {
              e.preventDefault();
              setResizingPane('left');
            }}
            onDoubleClick={() => setLeftPanelWidth(300)}
            title="Drag to resize Left Panel (double-click to reset)"
          />

          {/* CENTER STAGE: Dual Monitor & Unified NLE Timeline */}
          <section className="studio-panel" style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="studio-panel-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {activeSource
                    ? timelineMode === 'full-source'
                      ? activeSource.name
                      : activeClip?.name || activeSource.name
                    : 'Monitor'}
                </span>
                {activeSource && timelineMode !== 'full-source' && (
                  <button className="btn btn-sm" onClick={selectFullVideoOnTimeline}>
                    <Video size={11} />
                    Full Video
                  </button>
                )}
                {activeSource &&
                  timelineMode === 'full-source' &&
                  fullVideoClip &&
                  fullVideoClip.subCuts.length > 1 && (
                    <button
                      className="btn btn-sm"
                      onClick={() => {
                        setFullVideoClip(createInitialFullVideoClip(activeSource, activeScheme));
                        setSelectedCutIndex(0);
                        activeCutIdxRef.current = 0;
                        setMarkerNotice('Reset full video timeline.');
                        setTimeout(() => setMarkerNotice(null), 2200);
                      }}
                    >
                      <RotateCcw size={11} />
                      Reset Cuts
                    </button>
                  )}
                {activeClip?.backgroundFillStyle === 'split-screen' && (
                  <span className="badge-subtle">2-Speaker Split-Screen</span>
                )}
                {activeClip?.backgroundFillStyle !== 'split-screen' &&
                  activeClip?.subjectFocus?.label === '2-Speaker Auto-Switch' && (
                    <span className="badge-subtle">2-Speaker Auto-Switch</span>
                  )}
              </div>

              {activeSource && activeClip && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className={`btn ${isMuted ? 'btn-danger' : 'btn-active'}`}
                    style={{
                      height: 26,
                      padding: '0 10px',
                      fontSize: 11.5,
                      fontWeight: 600,
                      gap: 6,
                    }}
                    onClick={() => {
                      const nextMute = !isMuted;
                      setIsMuted(nextMute);
                      if (videoRef.current) videoRef.current.muted = nextMute;
                    }}
                    title={isMuted ? 'Click to turn sound ON' : 'Click to mute sound'}
                  >
                    {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                    {isMuted ? 'Sound Off' : 'Sound On'}
                  </button>
                  <span className="timecode-pill">
                    {formatSMPTETimecode(clipPlayheadTime)} / {formatSMPTETimecode(activeClip.duration)}
                  </span>
                </div>
              )}
            </div>

            {/* Viewport */}
            {!activeSource ? (
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 32,
                  background: '#060608',
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  const file = e.dataTransfer.files?.[0];
                  if (file) handleUploadVideoFile(file);
                }}
              >
                <div
                  onClick={() => sourceFileInputRef.current?.click()}
                  style={{
                    width: '100%',
                    maxWidth: 420,
                    padding: '40px 28px',
                    borderRadius: 8,
                    border: '1px dashed var(--border-strong)',
                    background: 'var(--bg-panel)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    textAlign: 'center',
                    gap: 10,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Upload size={18} color="var(--text-secondary)" />
                  </div>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>
                    Drop video or click to browse
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    MP4, MOV, or WebM
                  </div>
                </div>
              </div>
            ) : (
              <>
                {/* Dual Monitor Stage: Centered Dedicated Input Window & Output Window */}
                <div
                  ref={dualMonitorStageRef}
                  style={{
                    flex: 1,
                    display: 'grid',
                    gridTemplateColumns: `calc(${(monitorSplitRatio * 100).toFixed(1)}% - 5px) 10px calc(${((1 - monitorSplitRatio) * 100).toFixed(1)}% - 5px)`,
                    alignItems: 'stretch',
                    justifyContent: 'center',
                    padding: '10px 14px',
                    minHeight: 0,
                    background: '#050507',
                    overflow: 'hidden',
                  }}
                >
                  {/* WINDOW 1: INPUT / SOURCE MONITOR WINDOW */}
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      background: '#09090d',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 8,
                      overflow: 'hidden',
                      minWidth: 0,
                      minHeight: 0,
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
                    }}
                  >
                    {/* Input Window Header Bar */}
                    <div
                      style={{
                        width: '100%',
                        minHeight: 32,
                        padding: '4px 10px',
                        background: 'var(--bg-panel-header)',
                        borderBottom: '1px solid var(--border-subtle)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 6,
                        flexWrap: 'wrap',
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="section-label" style={{ color: 'var(--text-main)' }}>
                          Input Window · Source
                        </span>
                        <span className="badge-subtle">
                          {nativeDims.width}×{nativeDims.height}
                        </span>
                      </div>

                      {activeClip?.backgroundFillStyle === 'split-screen' ||
                      activeClip?.subjectFocus?.label === '2-Speaker Auto-Switch' ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <div className="seg-group">
                            <button
                              type="button"
                              className="seg-item"
                              style={{ height: 20, fontSize: 10.5, padding: '0 7px' }}
                              data-active={selectedSpeakerTarget === 'A'}
                              onClick={() => setSelectedSpeakerTarget('A')}
                              title="Click or drag on Input Video to position Speaker A"
                            >
                              Move Speaker A
                            </button>
                            <button
                              type="button"
                              className="seg-item"
                              style={{ height: 20, fontSize: 10.5, padding: '0 7px' }}
                              data-active={selectedSpeakerTarget === 'B'}
                              onClick={() => setSelectedSpeakerTarget('B')}
                              title="Click or drag on Input Video to position Speaker B"
                            >
                              Move Speaker B
                            </button>
                          </div>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>A</span>
                            <input
                              type="range"
                              min={0.5}
                              max={2.4}
                              step={0.05}
                              value={activeClip?.speakerAScale ?? 1.0}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                updateActiveTimelineClip((c) => ({ ...c, speakerAScale: val }));
                              }}
                              style={{ width: 40 }}
                              title="Scale Speaker A crop window size"
                            />
                          </div>
                          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                            <span style={{ fontSize: 9.5, color: 'var(--text-muted)' }}>B</span>
                            <input
                              type="range"
                              min={0.5}
                              max={2.4}
                              step={0.05}
                              value={activeClip?.speakerBScale ?? 1.0}
                              onChange={(e) => {
                                const val = parseFloat(e.target.value);
                                updateActiveTimelineClip((c) => ({ ...c, speakerBScale: val }));
                              }}
                              style={{ width: 40 }}
                              title="Scale Speaker B crop window size"
                            />
                          </div>
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ height: 20, fontSize: 10, padding: '0 6px' }}
                            onClick={() => {
                              const defY = nativeDims.width < nativeDims.height ? 0.39 : 0.44;
                              updateActiveTimelineClip((c) => ({
                                ...c,
                                speakerAX: 0.26,
                                speakerAY: defY,
                                speakerAScale: 1.0,
                                speakerBX: 0.74,
                                speakerBY: defY,
                                speakerBScale: 1.0,
                                splitScreenRatio: 0.5,
                                trackingOffsetX: 0,
                              }));
                            }}
                            title="Reset Speaker A and Speaker B positions and scales"
                          >
                            Reset A & B
                          </button>
                        </div>
                      ) : isSolvingObjectTrack ? (
                        <span className="badge-subtle">Tracking {objectTrackProgress}%</span>
                      ) : activeClip?.subjectFocus?.label ? (
                        <span className="badge-subtle">{activeClip.subjectFocus.label}</span>
                      ) : null}
                    </div>

                    {/* Centered Input Video Viewport */}
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        minWidth: 0,
                        padding: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: '#040406',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        ref={sourceOverlayWrapRef}
                        style={{
                          position: 'relative',
                          aspectRatio: `${nativeDims.width} / ${nativeDims.height}`,
                          height: nativeDims.width <= nativeDims.height ? '100%' : 'auto',
                          width: nativeDims.width > nativeDims.height ? '100%' : 'auto',
                          maxWidth: '100%',
                          maxHeight: '100%',
                          background: '#000',
                          borderRadius: 6,
                          overflow: 'hidden',
                          border: '1px solid var(--border-subtle)',
                          cursor: scalingSpeaker
                            ? 'nwse-resize'
                            : draggingSpeaker
                              ? 'grabbing'
                              : 'crosshair',
                        }}
                      onMouseDown={(e) => {
                        setIsDraggingCrop(true);
                        handlePointerOnSourceVideo(e, false);
                      }}
                      onMouseMove={(e) => {
                        if (scalingSpeaker && sourceOverlayWrapRef.current && activeClip) {
                          const rect = sourceOverlayWrapRef.current.getBoundingClientRect();
                          const nx = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
                          const isVert = nativeDims.width < nativeDims.height;
                          const baseW = isVert ? 0.46 : 0.44;
                          const centerX =
                            scalingSpeaker === 'A'
                              ? activeClip.speakerAX ?? 0.26
                              : activeClip.speakerBX ?? 0.74;
                          const halfSpan = Math.max(0.09, Math.min(0.45, Math.abs(nx - centerX)));
                          const desiredBoxW = halfSpan * 2;
                          const computedScale = Number(
                            Math.max(0.5, Math.min(2.4, baseW / desiredBoxW)).toFixed(2)
                          );
                          updateActiveTimelineClip((c) =>
                            scalingSpeaker === 'A'
                              ? { ...c, speakerAScale: computedScale }
                              : { ...c, speakerBScale: computedScale }
                          );
                          return;
                        }
                        if (draggingSpeaker && sourceOverlayWrapRef.current) {
                          const rect = sourceOverlayWrapRef.current.getBoundingClientRect();
                          const nx = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
                          const ny = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
                          updateSpeakerPositionOnClip(draggingSpeaker, nx, ny);
                          return;
                        }
                        if (isDraggingCrop) handlePointerOnSourceVideo(e, false);
                      }}
                      onMouseUp={(e) => {
                        if (scalingSpeaker || draggingSpeaker) {
                          setScalingSpeaker(null);
                          setDraggingSpeaker(null);
                          setIsDraggingCrop(false);
                          return;
                        }
                        if (isDraggingCrop) {
                          setIsDraggingCrop(false);
                          handlePointerOnSourceVideo(e, true);
                        }
                      }}
                      onMouseLeave={() => {
                        setScalingSpeaker(null);
                        setDraggingSpeaker(null);
                        setIsDraggingCrop(false);
                      }}
                      title={
                        activeClip?.backgroundFillStyle === 'split-screen' ||
                        activeClip?.subjectFocus?.label === '2-Speaker Auto-Switch'
                          ? 'Drag Speaker A or Speaker B box freely or drag its bottom-right corner handle to scale'
                          : 'Click any subject to lock 9:16 crop'
                      }
                    >
                      <video
                        ref={videoRef}
                        src={activeSource.url}
                        playsInline
                        preload="auto"
                        onLoadedMetadata={(e) => {
                          const v = e.currentTarget;
                          if (v.videoWidth && v.videoHeight) {
                            setNativeDims({ width: v.videoWidth, height: v.videoHeight });
                          }
                        }}
                        onLoadedData={() => {
                          if (videoRef.current && activeClip) {
                            const startT =
                              activeClip.subCuts[0]?.sourceStart ?? activeClip.sourceStart;
                            videoRef.current.currentTime = startT;
                          }
                          render9x16Preview();
                        }}
                        onSeeked={() => {
                          syncLiveObjectLockOnCurrentFrame();
                          render9x16Preview();
                        }}
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'block',
                          objectFit: 'contain',
                          pointerEvents: 'none',
                        }}
                      />

                      {activeFocusStrategy === 'click-track' && userFocusAnchors.length >= 2 && (
                        <svg
                          viewBox="0 0 100 100"
                          preserveAspectRatio="none"
                          style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            pointerEvents: 'none',
                            zIndex: 2,
                          }}
                        >
                          <polyline
                            fill="none"
                            stroke="rgba(250, 250, 250, 0.65)"
                            strokeWidth="0.5"
                            strokeDasharray="1.5 1"
                            points={buildSmoothUserAnchorCurvePoints(userFocusAnchors, 12)
                              .map((pt) => `${(pt.x * 100).toFixed(2)},${(pt.y * 100).toFixed(2)}`)
                              .join(' ')}
                          />
                        </svg>
                      )}

                      {activeFocusStrategy === 'click-track' &&
                        userFocusAnchors.length >= 2 &&
                        userFocusAnchors.map((pt, idx) => {
                          const isNearNow = Math.abs(pt.time - playheadTime) < 0.35;
                          return (
                            <div
                              key={`focus-lock-node-${pt.time}-${idx}`}
                              style={{
                                position: 'absolute',
                                left: `${pt.x * 100}%`,
                                top: `${pt.y * 100}%`,
                                transform: 'translate(-50%, -50%)',
                                width: 16,
                                height: 16,
                                borderRadius: '50%',
                                background: isNearNow ? '#fafafa' : 'rgba(9, 9, 11, 0.85)',
                                border: '1px solid #fafafa',
                                color: isNearNow ? '#09090b' : '#fafafa',
                                fontSize: 9,
                                fontWeight: 700,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                pointerEvents: 'none',
                                zIndex: 4,
                              }}
                            >
                              {idx + 1}
                            </div>
                          );
                        })}

                      {/* Freely Draggable & Scalable Speaker A & Speaker B Selectors OR Single 9:16 Crop Guide */}
                      {activeClip?.backgroundFillStyle === 'split-screen' ||
                      activeClip?.subjectFocus?.label === '2-Speaker Auto-Switch' ? (
                        (() => {
                          const isVert = nativeDims.width < nativeDims.height;
                          const defaultY = isVert ? 0.39 : 0.44;
                          const fineX = activeClip?.trackingOffsetX || 0;
                          const spkAX = Math.max(
                            0.06,
                            Math.min(0.94, (activeClip?.speakerAX ?? 0.26) + fineX)
                          );
                          const spkAY = Math.max(
                            0.06,
                            Math.min(0.94, activeClip?.speakerAY ?? defaultY)
                          );
                          const scaleA = Math.max(0.5, Math.min(2.4, activeClip?.speakerAScale ?? 1.0));

                          const spkBX = Math.max(
                            0.06,
                            Math.min(0.94, (activeClip?.speakerBX ?? 0.74) + fineX)
                          );
                          const spkBY = Math.max(
                            0.06,
                            Math.min(0.94, activeClip?.speakerBY ?? defaultY)
                          );
                          const scaleB = Math.max(0.5, Math.min(2.4, activeClip?.speakerBScale ?? 1.0));

                          const baseW = isVert ? 0.46 : 0.44;
                          const baseH = isVert ? 0.24 : 0.68;
                          const boxWA = Math.max(0.16, Math.min(0.9, baseW / scaleA));
                          const boxHA = Math.max(0.12, Math.min(0.9, baseH / scaleA));
                          const boxWB = Math.max(0.16, Math.min(0.9, baseW / scaleB));
                          const boxHB = Math.max(0.12, Math.min(0.9, baseH / scaleB));

                          const leftBoxX = Math.max(0, Math.min(1 - boxWA, spkAX - boxWA / 2));
                          const leftBoxY = Math.max(0, Math.min(1 - boxHA, spkAY - boxHA / 2));
                          const rightBoxX = Math.max(0, Math.min(1 - boxWB, spkBX - boxWB / 2));
                          const rightBoxY = Math.max(0, Math.min(1 - boxHB, spkBY - boxHB / 2));

                          const isSelA = selectedSpeakerTarget === 'A' || draggingSpeaker === 'A';
                          const isSelB = selectedSpeakerTarget === 'B' || draggingSpeaker === 'B';

                          return (
                            <>
                              {/* Draggable & Scalable Speaker A Selector Box */}
                              <div
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  setSelectedSpeakerTarget('A');
                                  setDraggingSpeaker('A');
                                  setSelectedLayerTrack('v2-speaker');
                                }}
                                style={{
                                  position: 'absolute',
                                  left: `${leftBoxX * 100}%`,
                                  top: `${leftBoxY * 100}%`,
                                  width: `${boxWA * 100}%`,
                                  height: `${boxHA * 100}%`,
                                  border: isSelA
                                    ? '2px solid #fafafa'
                                    : '1.5px dashed rgba(250, 250, 250, 0.75)',
                                  background: isSelA
                                    ? 'rgba(255, 255, 255, 0.08)'
                                    : 'rgba(255, 255, 255, 0.03)',
                                  cursor: draggingSpeaker === 'A' ? 'grabbing' : 'grab',
                                  zIndex: isSelA ? 6 : 5,
                                  userSelect: 'none',
                                }}
                                title="Drag to move Speaker A · Drag bottom-right corner handle to scale"
                              >
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 3,
                                    left: 3,
                                    background: isSelA ? '#fafafa' : 'rgba(9, 9, 11, 0.88)',
                                    border: '1px solid rgba(255,255,255,0.25)',
                                    color: isSelA ? '#09090b' : '#fafafa',
                                    fontSize: 9.5,
                                    fontWeight: 700,
                                    fontFamily: 'var(--font-mono)',
                                    padding: '1px 6px',
                                    borderRadius: 3,
                                    pointerEvents: 'none',
                                  }}
                                >
                                  SPEAKER A · {scaleA.toFixed(2)}x
                                </div>
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: 10,
                                    height: 10,
                                    borderRadius: '50%',
                                    border: '1.5px solid #fafafa',
                                    background: 'rgba(9, 9, 11, 0.75)',
                                    pointerEvents: 'none',
                                  }}
                                />
                                {/* Bottom-Right Scale Handle for Speaker A */}
                                <div
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    setSelectedSpeakerTarget('A');
                                    setScalingSpeaker('A');
                                    setSelectedLayerTrack('v2-speaker');
                                  }}
                                  style={{
                                    position: 'absolute',
                                    right: -4,
                                    bottom: -4,
                                    width: 11,
                                    height: 11,
                                    background: '#fafafa',
                                    border: '1px solid #09090b',
                                    borderRadius: 2,
                                    cursor: 'nwse-resize',
                                  }}
                                  title="Drag corner to scale Speaker A crop box"
                                />
                              </div>

                              {/* Draggable & Scalable Speaker B Selector Box */}
                              <div
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  setSelectedSpeakerTarget('B');
                                  setDraggingSpeaker('B');
                                  setSelectedLayerTrack('v2-speaker');
                                }}
                                style={{
                                  position: 'absolute',
                                  left: `${rightBoxX * 100}%`,
                                  top: `${rightBoxY * 100}%`,
                                  width: `${boxWB * 100}%`,
                                  height: `${boxHB * 100}%`,
                                  border: isSelB
                                    ? '2px solid #fafafa'
                                    : '1.5px dashed rgba(212, 212, 216, 0.75)',
                                  background: isSelB
                                    ? 'rgba(255, 255, 255, 0.08)'
                                    : 'rgba(255, 255, 255, 0.03)',
                                  cursor: draggingSpeaker === 'B' ? 'grabbing' : 'grab',
                                  zIndex: isSelB ? 6 : 5,
                                  userSelect: 'none',
                                }}
                                title="Drag to move Speaker B · Drag bottom-right corner handle to scale"
                              >
                                <div
                                  style={{
                                    position: 'absolute',
                                    top: 3,
                                    right: 3,
                                    background: isSelB ? '#fafafa' : 'rgba(9, 9, 11, 0.88)',
                                    border: '1px solid rgba(255,255,255,0.25)',
                                    color: isSelB ? '#09090b' : '#e4e4e7',
                                    fontSize: 9.5,
                                    fontWeight: 700,
                                    fontFamily: 'var(--font-mono)',
                                    padding: '1px 6px',
                                    borderRadius: 3,
                                    pointerEvents: 'none',
                                  }}
                                >
                                  SPEAKER B · {scaleB.toFixed(2)}x
                                </div>
                                <div
                                  style={{
                                    position: 'absolute',
                                    left: '50%',
                                    top: '50%',
                                    transform: 'translate(-50%, -50%)',
                                    width: 10,
                                    height: 10,
                                    borderRadius: '50%',
                                    border: '1.5px solid #e4e4e7',
                                    background: 'rgba(9, 9, 11, 0.75)',
                                    pointerEvents: 'none',
                                  }}
                                />
                                {/* Bottom-Right Scale Handle for Speaker B */}
                                <div
                                  onMouseDown={(e) => {
                                    e.stopPropagation();
                                    setSelectedSpeakerTarget('B');
                                    setScalingSpeaker('B');
                                    setSelectedLayerTrack('v2-speaker');
                                  }}
                                  style={{
                                    position: 'absolute',
                                    right: -4,
                                    bottom: -4,
                                    width: 11,
                                    height: 11,
                                    background: '#fafafa',
                                    border: '1px solid #09090b',
                                    borderRadius: 2,
                                    cursor: 'nwse-resize',
                                  }}
                                  title="Drag corner to scale Speaker B crop box"
                                />
                              </div>
                            </>
                          );
                        })()
                      ) : (
                        <div
                          style={{
                            position: 'absolute',
                            left: `${currentCrop.normX * 100}%`,
                            top: `${currentCrop.normY * 100}%`,
                            width: `${currentCrop.normW * 100}%`,
                            height: `${currentCrop.normH * 100}%`,
                            border: '1.5px solid rgba(250, 250, 250, 0.85)',
                            boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.55)',
                            pointerEvents: 'none',
                          }}
                        >
                          <div
                            style={{
                              position: 'absolute',
                              top: 4,
                              left: 4,
                              background: 'rgba(9, 9, 11, 0.78)',
                              border: '1px solid rgba(255,255,255,0.18)',
                              color: '#fafafa',
                              fontSize: 9.5,
                              fontFamily: 'var(--font-mono)',
                              padding: '1px 5px',
                              borderRadius: 3,
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {currentZoom.toFixed(2)}x
                          </div>
                        </div>
                      )}
                      </div>
                    </div>
                  </div>

                  {/* Center Draggable Splitter between Input Window and Output Window */}
                  <div
                    className={`studio-splitter-v ${resizingPane === 'monitors' ? 'is-dragging' : ''}`}
                    style={{
                      width: '100%',
                      height: '100%',
                      borderRadius: 4,
                    }}
                    onMouseDown={() => setResizingPane('monitors')}
                    onDoubleClick={() => setMonitorSplitRatio(0.5)}
                    title="Drag to resize Input Window vs Output Window (double-click to center 50/50)"
                  />

                  {/* WINDOW 2: 9:16 OUTPUT MONITOR WINDOW */}
                  <div
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                      background: '#09090d',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 8,
                      overflow: 'hidden',
                      minWidth: 0,
                      minHeight: 0,
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.45)',
                    }}
                  >
                    {/* Output Window Header Bar */}
                    <div
                      style={{
                        width: '100%',
                        minHeight: 32,
                        padding: '4px 10px',
                        background: 'var(--bg-panel-header)',
                        borderBottom: '1px solid var(--border-subtle)',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 6,
                        flexWrap: 'wrap',
                        flexShrink: 0,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="section-label" style={{ color: 'var(--text-main)' }}>
                          Output Window · 9:16
                        </span>
                        <span className="badge-subtle">1080×1920</span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span className="badge-subtle" title="Drag or scale layers directly on the 9:16 Output Monitor">
                          {activeClip?.backgroundFillStyle === 'split-screen'
                            ? `Split ${Math.round((activeClip?.splitScreenRatio ?? 0.5) * 100)}/${Math.round((1 - (activeClip?.splitScreenRatio ?? 0.5)) * 100)}`
                            : activeClip?.subjectFocus?.label === '2-Speaker Auto-Switch'
                              ? 'Auto-Switch'
                              : 'Single 9:16'}
                        </span>
                      </div>
                    </div>

                    {/* Centered 9:16 Output Video Viewport */}
                    <div
                      style={{
                        flex: 1,
                        minHeight: 0,
                        minWidth: 0,
                        padding: 10,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: '#040406',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        ref={outputOverlayWrapRef}
                        style={{
                          position: 'relative',
                          height: '100%',
                          maxHeight: '100%',
                          maxWidth: '100%',
                          width: 'auto',
                          aspectRatio: '9 / 16',
                          borderRadius: 6,
                          overflow: 'hidden',
                          border: '1px solid var(--border-strong)',
                          background: '#000',
                          userSelect: 'none',
                        }}
                      onMouseMove={(e) => {
                        if ((!draggingOutputLayer && !scalingOutputLayer) || !outputOverlayWrapRef.current || !activeClip)
                          return;
                        const rect = outputOverlayWrapRef.current.getBoundingClientRect();
                        if (rect.width <= 4 || rect.height <= 4) return;
                        const normX = Math.max(0.08, Math.min(0.92, (e.clientX - rect.left) / rect.width));
                        const normY = Math.max(0.06, Math.min(0.94, (e.clientY - rect.top) / rect.height));

                        if (scalingOutputLayer) {
                          if (scalingOutputLayer === 'captions') {
                            const cx = activeClip.captionPositionX ?? 0.5;
                            const dist = Math.abs(normX - cx);
                            const newScale = Number(
                              Math.max(0.55, Math.min(2.2, dist / 0.28)).toFixed(2)
                            );
                            updateActiveTimelineClip((c) => ({ ...c, captionFontScale: newScale }));
                          } else if (scalingOutputLayer === 'banner') {
                            const cx = activeClip.overlayBannerPositionX ?? 0.5;
                            const dist = Math.abs(normX - cx);
                            const newScale = Number(
                              Math.max(0.55, Math.min(2.4, dist / 0.28)).toFixed(2)
                            );
                            updateActiveTimelineClip((c) => ({ ...c, overlayBannerScale: newScale }));
                          } else {
                            updateActiveTimelineClip((c) => ({
                              ...c,
                              overlayLayers: (c.overlayLayers || []).map((ly) => {
                                if (ly.id !== scalingOutputLayer) return ly;
                                const dist = Math.abs(normX - ly.x);
                                const newScale = Number(
                                  Math.max(0.5, Math.min(2.5, dist / 0.25)).toFixed(2)
                                );
                                return { ...ly, scale: newScale };
                              }),
                            }));
                          }
                          return;
                        }

                        if (draggingOutputLayer === 'split-divider') {
                          const ratio = Number(Math.max(0.25, Math.min(0.75, normY)).toFixed(2));
                          updateActiveTimelineClip((c) => ({ ...c, splitScreenRatio: ratio }));
                        } else if (draggingOutputLayer === 'captions') {
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            captionPositionX: Number(normX.toFixed(3)),
                            captionPositionY: Number(normY.toFixed(3)),
                          }));
                        } else if (draggingOutputLayer === 'banner') {
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            overlayBannerPositionX: Number(normX.toFixed(3)),
                            overlayBannerPositionY: Number(normY.toFixed(3)),
                          }));
                        } else if (draggingOutputLayer) {
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            overlayLayers: (c.overlayLayers || []).map((ly) =>
                              ly.id === draggingOutputLayer
                                ? {
                                    ...ly,
                                    x: Number(normX.toFixed(3)),
                                    y: Number(normY.toFixed(3)),
                                  }
                                : ly
                            ),
                          }));
                        }
                      }}
                      onMouseUp={() => {
                        setDraggingOutputLayer(null);
                        setScalingOutputLayer(null);
                      }}
                      onMouseLeave={() => {
                        setDraggingOutputLayer(null);
                        setScalingOutputLayer(null);
                      }}
                    >
                      <canvas
                        ref={preview9x16CanvasRef}
                        width={540}
                        height={960}
                        style={{
                          width: '100%',
                          height: '100%',
                          display: 'block',
                        }}
                      />

                      {/* Interactive Split-Screen Divider Handle on 9:16 Output */}
                      {activeClip?.backgroundFillStyle === 'split-screen' && (
                        <div
                          onMouseDown={(e) => {
                            e.stopPropagation();
                            setSelectedLayerTrack('v2-speaker');
                            setDraggingOutputLayer('split-divider');
                          }}
                          title="Drag up/down to scale Top (Speaker A) vs Bottom (Speaker B) panel height"
                          style={{
                            position: 'absolute',
                            left: 0,
                            right: 0,
                            top: `${(activeClip.splitScreenRatio ?? 0.5) * 100}%`,
                            height: 12,
                            transform: 'translateY(-50%)',
                            cursor: 'ns-resize',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            zIndex: 18,
                          }}
                        >
                          <div
                            style={{
                              padding: '1px 6px',
                              borderRadius: 3,
                              background: 'rgba(9, 9, 11, 0.85)',
                              border: '1px solid rgba(255,255,255,0.35)',
                              color: '#fafafa',
                              fontSize: 8.5,
                              fontFamily: 'var(--font-mono)',
                              letterSpacing: '0.03em',
                            }}
                          >
                            SPLIT {Math.round((activeClip.splitScreenRatio ?? 0.5) * 100)}%
                          </div>
                        </div>
                      )}

                      {/* Interactive V4 Title Banner Box on 9:16 Output */}
                      {activeClip &&
                        !activeClip.hideBannerLayer &&
                        activeClip.overlayBannerText &&
                        activeClip.overlayBannerText.trim().length > 0 && (
                          <div
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedLayerTrack('v4-overlay');
                              setSelectedOverlayLayerId('__banner__');
                              setDraggingOutputLayer('banner');
                            }}
                            title="V4 Banner Layer — Drag to move, drag bottom-right corner to scale"
                            style={{
                              position: 'absolute',
                              left: `${(activeClip.overlayBannerPositionX ?? 0.5) * 100}%`,
                              top: `${(activeClip.overlayBannerPositionY ?? 0.14) * 100}%`,
                              width: `${Math.min(92, Math.max(36, 56 * (activeClip.overlayBannerScale ?? 1.0)))}%`,
                              height: `${Math.min(28, Math.max(9, 12 * (activeClip.overlayBannerScale ?? 1.0)))}%`,
                              transform: 'translate(-50%, -50%)',
                              border:
                                selectedLayerTrack === 'v4-overlay' &&
                                selectedOverlayLayerId === '__banner__'
                                  ? '1.5px dashed #f59e0b'
                                  : '1px dashed rgba(245, 158, 11, 0.45)',
                              borderRadius: 4,
                              cursor: 'move',
                              zIndex: 20,
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                top: -14,
                                left: 0,
                                background: 'rgba(245, 158, 11, 0.92)',
                                color: '#09090b',
                                fontSize: 8,
                                fontWeight: 700,
                                fontFamily: 'var(--font-mono)',
                                padding: '0 4px',
                                borderRadius: 2,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              V4 BANNER · {Math.round((activeClip.overlayBannerScale ?? 1) * 100)}%
                            </span>
                            <div
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setSelectedLayerTrack('v4-overlay');
                                setSelectedOverlayLayerId('__banner__');
                                setScalingOutputLayer('banner');
                              }}
                              title="Drag corner to scale V4 Banner Layer"
                              style={{
                                position: 'absolute',
                                right: -5,
                                bottom: -5,
                                width: 10,
                                height: 10,
                                background: '#f59e0b',
                                border: '1.5px solid #09090b',
                                borderRadius: 2,
                                cursor: 'nwse-resize',
                              }}
                            />
                          </div>
                        )}

                      {/* Interactive Custom V4 VideoOverlayLayer Items on 9:16 Output */}
                      {activeClip &&
                        !activeClip.hideBannerLayer &&
                        (activeClip.overlayLayers || []).map((ly) => {
                          if (!ly.visible || !ly.text.trim()) return null;
                          if (
                            clipPlayheadTime < ly.startTime - 0.05 ||
                            clipPlayheadTime > ly.endTime + 0.05
                          ) {
                            return null;
                          }
                          const isSel =
                            selectedLayerTrack === 'v4-overlay' && selectedOverlayLayerId === ly.id;
                          return (
                            <div
                              key={ly.id}
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setSelectedLayerTrack('v4-overlay');
                                setSelectedOverlayLayerId(ly.id);
                                setDraggingOutputLayer(ly.id);
                              }}
                              title={`V4 Layer "${ly.text}" — Drag to move, corner to scale`}
                              style={{
                                position: 'absolute',
                                left: `${ly.x * 100}%`,
                                top: `${ly.y * 100}%`,
                                width: `${Math.min(92, Math.max(32, 50 * (ly.scale || 1)))}%`,
                                height: `${Math.min(26, Math.max(8, 11 * (ly.scale || 1)))}%`,
                                transform: 'translate(-50%, -50%)',
                                border: isSel
                                  ? '1.5px dashed #f59e0b'
                                  : '1px dashed rgba(245, 158, 11, 0.45)',
                                borderRadius: 4,
                                cursor: 'move',
                                zIndex: 21,
                              }}
                            >
                              <span
                                style={{
                                  position: 'absolute',
                                  top: -14,
                                  left: 0,
                                  background: 'rgba(245, 158, 11, 0.92)',
                                  color: '#09090b',
                                  fontSize: 8,
                                  fontWeight: 700,
                                  fontFamily: 'var(--font-mono)',
                                  padding: '0 4px',
                                  borderRadius: 2,
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                V4 TEXT · {Math.round((ly.scale || 1) * 100)}%
                              </span>
                              <div
                                onMouseDown={(e) => {
                                  e.stopPropagation();
                                  setSelectedLayerTrack('v4-overlay');
                                  setSelectedOverlayLayerId(ly.id);
                                  setScalingOutputLayer(ly.id);
                                }}
                                title="Drag corner to scale text layer"
                                style={{
                                  position: 'absolute',
                                  right: -5,
                                  bottom: -5,
                                  width: 10,
                                  height: 10,
                                  background: '#f59e0b',
                                  border: '1.5px solid #09090b',
                                  borderRadius: 2,
                                  cursor: 'nwse-resize',
                                }}
                              />
                            </div>
                          );
                        })}

                      {/* Interactive V3 Captions Layer Box on 9:16 Output */}
                      {activeClip &&
                        !activeClip.hideCaptions &&
                        ((activeClip.captions && activeClip.captions.length > 0) ||
                          (activeClip.captionText && activeClip.captionText.trim().length > 0)) && (
                          <div
                            onMouseDown={(e) => {
                              e.stopPropagation();
                              setSelectedLayerTrack('v3-captions');
                              setDraggingOutputLayer('captions');
                            }}
                            title="V3 Captions Layer — Drag anywhere on 9:16 Output to reposition, drag corner to scale font size"
                            style={{
                              position: 'absolute',
                              left: `${(activeClip.captionPositionX ?? 0.5) * 100}%`,
                              top: `${(activeClip.captionPositionY ?? 0.77) * 100}%`,
                              width: `${Math.min(94, Math.max(40, 58 * (activeClip.captionFontScale ?? 1.0)))}%`,
                              height: `${Math.min(28, Math.max(9, 13 * (activeClip.captionFontScale ?? 1.0)))}%`,
                              transform: 'translate(-50%, -50%)',
                              border:
                                selectedLayerTrack === 'v3-captions'
                                  ? '1.5px dashed #a855f7'
                                  : '1px dashed rgba(168, 85, 247, 0.45)',
                              borderRadius: 4,
                              cursor: 'move',
                              zIndex: 19,
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                top: -14,
                                left: 0,
                                background: 'rgba(168, 85, 247, 0.92)',
                                color: '#fafafa',
                                fontSize: 8,
                                fontWeight: 700,
                                fontFamily: 'var(--font-mono)',
                                padding: '0 4px',
                                borderRadius: 2,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              V3 CAPTIONS · {Math.round((activeClip.captionFontScale ?? 1) * 100)}%
                            </span>
                            <div
                              onMouseDown={(e) => {
                                e.stopPropagation();
                                setSelectedLayerTrack('v3-captions');
                                setScalingOutputLayer('captions');
                              }}
                              title="Drag corner to scale V3 Captions font size"
                              style={{
                                position: 'absolute',
                                right: -5,
                                bottom: -5,
                                width: 10,
                                height: 10,
                                background: '#a855f7',
                                border: '1.5px solid #09090b',
                                borderRadius: 2,
                                cursor: 'nwse-resize',
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Control Bar 1: 9:16 Subject Focus, Lock Points, Zoom & Fine X Offset */}
                <div
                  style={{
                    padding: '6px 12px',
                    background: 'var(--bg-panel-header)',
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  {/* Left: Segmented Subject Focus Presets + Active Focus Lock Nodes */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span className="section-label">Subject Focus</span>
                    <div className="seg-group">
                      <button
                        type="button"
                        className="seg-item"
                        data-active={
                          activeClip?.backgroundFillStyle !== 'split-screen' &&
                          activeFocusStrategy === 'click-track'
                        }
                        onClick={() => {
                          setClickPickMode('track');
                          if (activeClip?.subjectFocus) {
                            applySubjectFocusConfig({
                              ...activeClip.subjectFocus,
                              strategy: 'click-track',
                              label: 'Tracked Subject',
                            });
                          }
                        }}
                        title="Click any moving person or object on the Source Video to track it"
                      >
                        <Crosshair size={11} />
                        Track Subject
                      </button>
                      <button
                        type="button"
                        className="seg-item"
                        data-active={
                          activeClip?.backgroundFillStyle !== 'split-screen' &&
                          activeFocusStrategy === 'static-lock' &&
                          activeClip?.subjectFocus?.label !== '2-Speaker Auto-Switch'
                        }
                        onClick={() => {
                          setClickPickMode('static');
                          handleSelectSubjectFocusStrategy('static-lock');
                        }}
                        title="Lock static 9:16 center frame"
                      >
                        <Lock size={11} />
                        Center Lock
                      </button>
                      <button
                        type="button"
                        className="seg-item"
                        data-active={
                          activeClip?.backgroundFillStyle !== 'split-screen' &&
                          activeFocusStrategy === 'face-speaker'
                        }
                        onClick={() => handleSelectSubjectFocusStrategy('face-speaker')}
                      >
                        <UserCheck size={11} />
                        Auto Face
                      </button>
                      <button
                        type="button"
                        className="seg-item"
                        data-active={
                          activeClip?.backgroundFillStyle !== 'split-screen' &&
                          activeFocusStrategy === 'left-subject'
                        }
                        onClick={() => handleSelectSubjectFocusStrategy('left-subject')}
                        title="Isolate Left Speaker in 9:16 frame"
                      >
                        Left Speaker
                      </button>
                      <button
                        type="button"
                        className="seg-item"
                        data-active={
                          activeClip?.backgroundFillStyle !== 'split-screen' &&
                          activeFocusStrategy === 'right-subject'
                        }
                        onClick={() => handleSelectSubjectFocusStrategy('right-subject')}
                        title="Isolate Right Speaker in 9:16 frame"
                      >
                        Right Speaker
                      </button>
                      <button
                        type="button"
                        className="seg-item"
                        data-active={
                          activeClip?.backgroundFillStyle !== 'split-screen' &&
                          activeFocusStrategy === 'action-motion'
                        }
                        onClick={() => handleSelectSubjectFocusStrategy('action-motion')}
                      >
                        Motion
                      </button>
                    </div>

                    {/* Focus Lock Pills + Step +2s & Reset */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                      {userFocusAnchors.map((pt, idx) => (
                        <span
                          key={`lock-pill-${pt.time}-${idx}`}
                          className="badge-subtle"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            cursor: 'pointer',
                          }}
                          onClick={() => handleSeekSourceTime(pt.time)}
                          title="Click to jump playhead to this Focus Lock point"
                        >
                          #{idx + 1} {pt.time.toFixed(1)}s
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteFocusLockPoint(pt.time);
                            }}
                            style={{
                              background: 'none',
                              border: 'none',
                              color: 'var(--text-muted)',
                              cursor: 'pointer',
                              padding: 0,
                            }}
                          >
                            ×
                          </button>
                        </span>
                      ))}

                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          if (!activeSource) return;
                          if (videoRef.current && !videoRef.current.paused) {
                            videoRef.current.pause();
                            setIsPlaying(false);
                          }
                          const nextTime = Math.min(activeSource.duration - 0.05, playheadTime + 2.0);
                          handleSeekSourceTime(nextTime);
                          setClickPickMode('track');
                          setMarkerNotice(
                            `Stepped to ${nextTime.toFixed(1)}s — click subject on Source Video to add Lock #${userFocusAnchors.length + 1}`
                          );
                          setTimeout(() => setMarkerNotice(null), 3200);
                        }}
                        title="Step forward 2 seconds to place another Focus Lock point"
                      >
                        +2s Add Lock
                      </button>

                      {userFocusAnchors.length > 0 && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            userFocusAnchorsRef.current = [];
                            liveTrackedAnchorRef.current = null;
                            handleSelectSubjectFocusStrategy('auto-salient');
                          }}
                        >
                          Clear Locks
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Right: Zoom Slider + 1:1 / Fit + Fine X Offset + All Clips Toggle */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span className="section-label">Zoom</span>
                      <input
                        type="range"
                        min={0.56}
                        max={2.2}
                        step={0.02}
                        value={currentZoom}
                        onChange={(e) =>
                          applyZoomAcrossStudio(parseFloat(e.target.value), applyFocusToAllClips)
                        }
                        style={{ width: 68 }}
                      />
                      <span className="badge-subtle" style={{ minWidth: 38, textAlign: 'center' }}>
                        {currentZoom.toFixed(2)}x
                      </span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => applyZoomAcrossStudio(1.0, true)}
                      >
                        1.0x
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => applyZoomAcrossStudio(0.56, true)}
                        title="Zoom out to fit wide frame inside 9:16"
                      >
                        Fit 16:9
                      </button>
                    </div>

                    <div className="studio-divider-v" />

                    {/* Fine X Offset Slider */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span className="section-label">Fine X</span>
                      <input
                        type="range"
                        min={-0.4}
                        max={0.4}
                        step={0.01}
                        value={activeClip?.trackingOffsetX || 0}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (applyFocusToAllClips) {
                            setFullVideoClip((prev) =>
                              prev ? { ...prev, trackingOffsetX: val } : prev
                            );
                            setGeneratedClips((prev) =>
                              prev.map((c) => ({ ...c, trackingOffsetX: val }))
                            );
                          } else {
                            updateActiveTimelineClip((c) => ({ ...c, trackingOffsetX: val }));
                          }
                        }}
                        onDoubleClick={() =>
                          updateActiveTimelineClip((c) => ({ ...c, trackingOffsetX: 0 }))
                        }
                        style={{ width: 54 }}
                        title="Fine horizontal crop offset (double-click to reset to 0)"
                      />
                      <span className="badge-subtle" style={{ minWidth: 32, textAlign: 'center' }}>
                        {((activeClip?.trackingOffsetX || 0) * 100).toFixed(0)}%
                      </span>
                    </div>

                    <div className="studio-divider-v" />

                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                        cursor: 'pointer',
                        userSelect: 'none',
                      }}
                      title="Apply subject focus & zoom changes across all clips"
                    >
                      <input
                        type="checkbox"
                        checked={applyFocusToAllClips}
                        onChange={(e) => setApplyFocusToAllClips(e.target.checked)}
                        style={{ accentColor: '#fafafa', width: 12, height: 12 }}
                      />
                      All Clips
                    </label>
                  </div>
                </div>

                {/* Control Bar 2: 2-Speaker Podcast Modes, AI Edit Skills, Captions & Fill Layout */}
                <div
                  style={{
                    padding: '6px 12px',
                    background: 'var(--bg-panel)',
                    borderTop: '1px solid var(--border-subtle)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  {/* Left: Dedicated 2-Speaker Podcast Controls + AI Audio/Cut Tools */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                    <span className="section-label">2-Speaker & AI Tools</span>

                    <button
                      type="button"
                      className={`btn btn-sm ${
                        activeClip?.backgroundFillStyle === 'split-screen' ? 'btn-active' : ''
                      }`}
                      onClick={() => handleTwoSpeakerMode('split-screen')}
                      title="Stack Speaker A (Top) and Speaker B (Bottom) in a 9:16 Dual Split-Screen"
                    >
                      <Layers size={11} />
                      2-Speaker Split-Screen
                    </button>

                    <button
                      type="button"
                      className={`btn btn-sm ${
                        activeClip?.backgroundFillStyle !== 'split-screen' &&
                        activeClip?.subjectFocus?.label === '2-Speaker Auto-Switch'
                          ? 'btn-active'
                          : ''
                      }`}
                      onClick={() => handleTwoSpeakerMode('auto-switch')}
                      title="Automatically cut back and forth between Speaker A (Left) and Speaker B (Right)"
                    >
                      <UserCheck size={11} />
                      Auto-Switch Speakers
                    </button>

                    <div className="studio-divider-v" />

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        if (!activeClip || !activeSource) return;
                        updateActiveTimelineClip((clip) => {
                          const res = stripSilenceFromClip(clip, activeSource, 0.18);
                          setMarkerNotice(
                            `Stripped ${res.removedSeconds.toFixed(1)}s of dead air (${res.cutsCreated} cuts)`
                          );
                          setTimeout(() => setMarkerNotice(null), 2600);
                          return res.updatedClip;
                        });
                      }}
                    >
                      <Scissors size={11} />
                      Strip Dead Air
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        if (!activeClip || !activeSource) return;
                        updateActiveTimelineClip((clip) => {
                          const res = snapCutsToAudioBeats(clip, activeSource);
                          setMarkerNotice(`Synced ${res.beatCutsCount} cuts to audio peaks`);
                          setTimeout(() => setMarkerNotice(null), 2600);
                          return res.updatedClip;
                        });
                      }}
                    >
                      <Zap size={11} />
                      Beat-Sync Cuts
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={isTranscribingAudio}
                      onClick={handleRunAITranscription}
                    >
                      <Mic size={11} />
                      {isTranscribingAudio
                        ? `Transcribing ${transcriptionProgress}%`
                        : 'Transcribe Captions'}
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setIsTranscriptEditorOpen(true)}
                      title="Open window to edit full video transcription and caption lines"
                    >
                      <FileText size={11} />
                      Edit Transcript
                    </button>
                  </div>

                  {/* Right: Caption Style Dropdown, 9:16 Fill Mode & Playback Speed */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    {/* Radix Dropdown for Caption Style & Placement */}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button type="button" className="btn btn-sm">
                          <span>
                            Captions:{' '}
                            {activeClip?.hideCaptions
                              ? 'Hidden'
                              : activeClip?.captionStyle || 'Hormozi'}
                          </span>
                          <ChevronDown size={11} />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content className="rx-dropdown-content" sideOffset={5}>
                          <div className="rx-dropdown-label">Caption Style</div>
                          {(
                            [
                              { id: 'bold-hormozi', label: 'Bold Hormozi' },
                              { id: 'clean-minimal', label: 'Clean Minimal' },
                              { id: 'kinetic-neon', label: 'Kinetic Neon' },
                              { id: 'graffiti-pop', label: 'Street / Marker' },
                              { id: 'editorial-serif', label: 'Editorial Serif' },
                            ] as const
                          ).map((st) => {
                            const isSel =
                              !activeClip?.hideCaptions &&
                              (activeClip?.captionStyle || 'bold-hormozi') === st.id;
                            return (
                              <DropdownMenu.Item
                                key={st.id}
                                className="rx-dropdown-item"
                                onSelect={() => {
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    hideCaptions: false,
                                    captionStyle: st.id as any,
                                  }));
                                }}
                              >
                                <span>{st.label}</span>
                                {isSel && <Check size={12} />}
                              </DropdownMenu.Item>
                            );
                          })}
                          <DropdownMenu.Separator className="rx-dropdown-separator" />
                          <div className="rx-dropdown-label">Placement</div>
                          {(
                            [
                              { label: 'Top', y: 0.14 },
                              { label: 'Middle', y: 0.5 },
                              { label: 'Bottom', y: 0.77 },
                            ] as const
                          ).map((pos) => {
                            const curY = activeClip?.captionPositionY ?? 0.77;
                            const isSel = !activeClip?.hideCaptions && Math.abs(curY - pos.y) < 0.08;
                            return (
                              <DropdownMenu.Item
                                key={pos.label}
                                className="rx-dropdown-item"
                                onSelect={() => {
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    hideCaptions: false,
                                    captionPositionY: pos.y,
                                  }));
                                }}
                              >
                                <span>{pos.label}</span>
                                {isSel && <Check size={12} />}
                              </DropdownMenu.Item>
                            );
                          })}
                          <DropdownMenu.Separator className="rx-dropdown-separator" />
                          <DropdownMenu.Item
                            className="rx-dropdown-item"
                            onSelect={() => {
                              updateActiveTimelineClip((c) => ({
                                ...c,
                                hideCaptions: !c.hideCaptions,
                              }));
                            }}
                          >
                            <span>{activeClip?.hideCaptions ? 'Show Captions' : 'Hide Captions'}</span>
                            {activeClip?.hideCaptions && <Check size={12} />}
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>

                    {/* 9:16 Fill Mode Segmented Group */}
                    <div className="seg-group">
                      {(
                        [
                          { id: 'blurred', label: 'Blur Fill' },
                          { id: 'black', label: 'Black Bars' },
                          { id: 'split-screen', label: 'Split-Screen' },
                        ] as Array<{ id: BackgroundFillStyle; label: string }>
                      ).map((opt) => {
                        const activeFill = activeClip?.backgroundFillStyle ?? 'blurred';
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            className="seg-item"
                            data-active={activeFill === opt.id}
                            onClick={() => {
                              if (opt.id === 'split-screen') {
                                handleTwoSpeakerMode('split-screen');
                              } else {
                                updateActiveTimelineClip((c) => ({
                                  ...c,
                                  backgroundFillStyle: opt.id,
                                }));
                              }
                            }}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>

                    {/* Radix Dropdown for Playback Speed */}
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button type="button" className="btn btn-sm">
                          <span style={{ fontFamily: 'var(--font-mono)' }}>
                            {(activeClip?.playbackSpeed ?? 1.0).toFixed(2).replace(/\.00$/, '.0')}x
                          </span>
                          <ChevronDown size={11} />
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content className="rx-dropdown-content" sideOffset={5}>
                          <div className="rx-dropdown-label">Playback Speed</div>
                          {[0.75, 1.0, 1.25, 1.5].map((spd) => {
                            const curSpd = activeClip?.playbackSpeed ?? 1.0;
                            const isSel = Math.abs(curSpd - spd) < 0.03;
                            return (
                              <DropdownMenu.Item
                                key={spd}
                                className="rx-dropdown-item"
                                onSelect={() => {
                                  if (videoRef.current) videoRef.current.playbackRate = spd;
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    playbackSpeed: spd,
                                    subCuts: c.subCuts.map((cut) => ({ ...cut, speed: spd })),
                                  }));
                                }}
                              >
                                <span style={{ fontFamily: 'var(--font-mono)' }}>{spd}x</span>
                                {isSel && <Check size={12} />}
                              </DropdownMenu.Item>
                            );
                          })}
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                </div>
              </>
            )}

            {/* Horizontal Resizable Splitter between Video Monitors and Multi-Track Layer Dock */}
            {activeSource && activeClip && (
              <div
                className={`studio-splitter-h ${resizingPane === 'timeline' ? 'is-dragging' : ''}`}
                onMouseDown={() => setResizingPane('timeline')}
                onDoubleClick={() => setTimelineHeight(265)}
                title="Drag to resize Video Monitors vs Multi-Track Layer Timeline (double-click to reset)"
              />
            )}

            {/* Multi-Track NLE Layer Dock: Transport, Video Layers (V4/V3/V2/V1/A1) & Active Layer Inspector */}
            {activeSource && activeClip && (
              <div
                style={{
                  height: timelineHeight,
                  minHeight: 175,
                  maxHeight: 520,
                  flexShrink: 0,
                  padding: '8px 12px 10px',
                  background: 'var(--bg-panel)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  overflowY: 'auto',
                }}
              >
                {/* Transport & Layer Actions Bar */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      className="btn btn-primary"
                      style={{
                        height: 28,
                        padding: '0 12px',
                        fontSize: 12,
                        fontWeight: 600,
                      }}
                      onClick={() => handleTogglePlay(false)}
                    >
                      {isPlaying && !isLoopingInOut ? <Pause size={13} /> : <Play size={13} />}
                      {isPlaying && !isLoopingInOut ? 'Pause' : 'Play'}
                    </button>

                    <button
                      type="button"
                      className={`btn ${isMuted ? 'btn-danger' : 'btn-active'}`}
                      style={{
                        height: 28,
                        padding: '0 11px',
                        fontSize: 12,
                        fontWeight: 600,
                        gap: 6,
                      }}
                      onClick={() => {
                        const nextMute = !isMuted;
                        setIsMuted(nextMute);
                        if (videoRef.current) videoRef.current.muted = nextMute;
                      }}
                      title={isMuted ? 'Click to turn sound ON' : 'Click to mute sound'}
                    >
                      {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
                      {isMuted ? 'Sound Off (Muted)' : 'Sound On'}
                    </button>

                    <div className="studio-divider-v" />

                    <button
                      type="button"
                      className={`btn btn-sm ${isRazorMode ? 'btn-active' : ''}`}
                      onClick={() => setIsRazorMode((prev) => !prev)}
                      title="Razor Tool (C)"
                    >
                      <Scissors size={11} />
                      Razor [C]
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={handleSplitAtPlayhead}
                    >
                      Split Cut
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const newId = `ov-${Date.now()}`;
                        const startT = Number(Math.max(0, clipPlayheadTime).toFixed(2));
                        const endT = Number(
                          Math.min(activeClip.duration, startT + Math.min(6, activeClip.duration)).toFixed(2)
                        );
                        const newLayer: VideoOverlayLayer = {
                          id: newId,
                          name: `Text Layer ${(activeClip.overlayLayers?.length || 0) + 1}`,
                          kind: 'text-banner',
                          text: 'NEW OVERLAY TEXT',
                          x: 0.5,
                          y: 0.22,
                          scale: 1.0,
                          startTime: startT,
                          endTime: Math.max(startT + 0.5, endT),
                          bgColor: 'rgba(12, 12, 16, 0.88)',
                          textColor: '#ffffff',
                          visible: true,
                        };
                        updateActiveTimelineClip((c) => ({
                          ...c,
                          hideBannerLayer: false,
                          overlayLayers: [...(c.overlayLayers || []), newLayer],
                        }));
                        setSelectedLayerTrack('v4-overlay');
                        setSelectedOverlayLayerId(newId);
                      }}
                      title="Add a new movable & scalable V4 Text Overlay Layer at the playhead"
                    >
                      <Plus size={11} />
                      + Text Layer (V4)
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        const startT = Number(Math.max(0, clipPlayheadTime).toFixed(2));
                        const endT = Number(
                          Math.min(activeClip.duration, startT + 3.0).toFixed(2)
                        );
                        const newCapId = `cap-manual-${Date.now()}`;
                        updateActiveTimelineClip((c) => {
                          const existing = c.captions || [];
                          const nextSeg = {
                            id: newCapId,
                            start: startT,
                            end: Math.max(startT + 0.4, endT),
                            text: c.captionText || 'New caption layer',
                            words: [
                              {
                                word: c.captionText || 'New caption layer',
                                start: startT,
                                end: Math.max(startT + 0.4, endT),
                              },
                            ],
                          };
                          return {
                            ...c,
                            hideCaptions: false,
                            captions: [...existing, nextSeg],
                          };
                        });
                        setSelectedLayerTrack('v3-captions');
                        setSelectedCaptionId(newCapId);
                      }}
                      title="Add a timed V3 Caption block at the playhead"
                    >
                      <Type size={11} />
                      + Caption (V3)
                    </button>

                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setIsTranscriptEditorOpen(true)}
                      title="Open Transcript & Captions Editor Window"
                    >
                      <FileText size={11} />
                      Edit Transcript
                    </button>

                    {activeClip.subCuts.length > 1 && inspectedCut && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={handleDeleteSelectedCut}
                        >
                          <Trash2 size={11} />
                          Delete Cut #{inspectedCut.index}
                        </button>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={handleSaveSelectedCutAsClip}
                        >
                          <Plus size={11} />
                          Save Cut
                        </button>
                      </>
                    )}
                  </div>

                  {/* In / Out Range Bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <button
                      className="btn btn-sm"
                      onClick={handleSetInMarkerAtPlayhead}
                      title="Set In (I)"
                    >
                      In [I]
                    </button>

                    <span className="badge-subtle" style={{ padding: '2px 7px' }}>
                      {inMarker !== null ? `${inMarker.toFixed(1)}s` : '--'} –{' '}
                      {outMarker !== null ? `${outMarker.toFixed(1)}s` : '--'}
                      {inMarker !== null && outMarker !== null && (
                        <span style={{ color: 'var(--text-main)', marginLeft: 5 }}>
                          ({markedDuration.toFixed(1)}s)
                        </span>
                      )}
                    </span>

                    <button
                      className="btn btn-sm"
                      onClick={handleSetOutMarkerAtPlayhead}
                      title="Set Out (O)"
                    >
                      Out [O]
                    </button>

                    {inMarker !== null && outMarker !== null && outMarker > inMarker && (
                      <>
                        <button
                          className={`btn btn-sm ${isLoopingInOut ? 'btn-active' : ''}`}
                          onClick={() => handleTogglePlay(true)}
                        >
                          <Play size={10} />
                          Loop
                        </button>
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => handleCreateClipFromMarkers(true, false)}
                        >
                          Create Clip
                        </button>
                        <button
                          className="btn btn-sm"
                          onClick={() => handleCreateClipFromMarkers(true, true)}
                        >
                          Compile
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* MULTI-TRACK NLE VIDEO LAYER STACK (V4 Overlays, V3 Captions, V2 Speaker B, V1 Video Cuts, A1 Audio) */}
                <div className="nle-layer-stack">
                  {/* LAYER V4: TEXT & GRAPHIC OVERLAYS */}
                  <div
                    className={`nle-layer-row ${selectedLayerTrack === 'v4-overlay' ? 'is-selected' : ''}`}
                    style={{ height: 28 }}
                    onClick={() => setSelectedLayerTrack('v4-overlay')}
                  >
                    <div className="nle-layer-header">
                      <span className="nle-layer-title">
                        <span style={{ color: '#f59e0b', fontFamily: 'var(--font-mono)' }}>V4</span>
                        <span>Overlays</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-icon"
                        style={{ width: 20, height: 20 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            hideBannerLayer: !c.hideBannerLayer,
                          }));
                        }}
                        title={activeClip.hideBannerLayer ? 'Show V4 Overlay Layers' : 'Hide V4 Overlay Layers'}
                      >
                        {activeClip.hideBannerLayer ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                    </div>
                    <div
                      className="nle-layer-track"
                      onMouseDown={(e) => {
                        setSelectedLayerTrack('v4-overlay');
                        updateTimelineDragAtClientX(e.clientX, 'playhead');
                      }}
                    >
                      {/* Title Banner Layer Block */}
                      {activeClip.overlayBannerText && activeClip.overlayBannerText.trim().length > 0 && (
                        <div
                          className={`nle-layer-block ${
                            selectedLayerTrack === 'v4-overlay' && selectedOverlayLayerId === '__banner__'
                              ? 'is-active'
                              : ''
                          }`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedLayerTrack('v4-overlay');
                            setSelectedOverlayLayerId('__banner__');
                          }}
                          style={{
                            left: '0%',
                            width: '100%',
                            background: activeClip.hideBannerLayer
                              ? 'rgba(113, 113, 122, 0.16)'
                              : 'rgba(245, 158, 11, 0.24)',
                            border: '1px solid rgba(245, 158, 11, 0.65)',
                            color: '#fde68a',
                          }}
                        >
                          Banner: {activeClip.overlayBannerText} ({Math.round((activeClip.overlayBannerScale ?? 1) * 100)}%)
                        </div>
                      )}

                      {/* Custom Timed VideoOverlayLayers */}
                      {(activeClip.overlayLayers || []).map((ly) => {
                        const dur = Math.max(0.5, activeClip.duration);
                        const leftPct = Math.max(0, Math.min(98, (ly.startTime / dur) * 100));
                        const widthPct = Math.max(
                          3,
                          Math.min(100 - leftPct, ((ly.endTime - ly.startTime) / dur) * 100)
                        );
                        const isSel =
                          selectedLayerTrack === 'v4-overlay' && selectedOverlayLayerId === ly.id;
                        return (
                          <div
                            key={ly.id}
                            className={`nle-layer-block ${isSel ? 'is-active' : ''}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLayerTrack('v4-overlay');
                              setSelectedOverlayLayerId(ly.id);
                            }}
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              background: ly.visible
                                ? 'rgba(245, 158, 11, 0.32)'
                                : 'rgba(113, 113, 122, 0.2)',
                              border: '1px solid #f59e0b',
                              color: '#fef3c7',
                            }}
                          >
                            {ly.text} ({Math.round((ly.scale || 1) * 100)}%)
                          </div>
                        );
                      })}

                      {!activeClip.overlayBannerText?.trim() &&
                        (!activeClip.overlayLayers || activeClip.overlayLayers.length === 0) && (
                          <span
                            style={{
                              fontSize: 9.5,
                              color: 'var(--text-muted)',
                              paddingLeft: 8,
                              alignSelf: 'center',
                              pointerEvents: 'none',
                            }}
                          >
                            Click "+ Text Layer (V4)" or inspect V4 to add title banners & text layers
                          </span>
                        )}

                      {/* Playhead needle */}
                      <div
                        style={{
                          position: 'absolute',
                          left: `${Math.max(0, Math.min(100, (clipPlayheadTime / Math.max(0.1, activeClip.duration)) * 100))}%`,
                          top: 0,
                          bottom: 0,
                          width: 2,
                          background: '#fafafa',
                          pointerEvents: 'none',
                          zIndex: 15,
                        }}
                      />
                    </div>
                  </div>

                  {/* LAYER V3: CAPTIONS / SUBTITLES LAYER */}
                  <div
                    className={`nle-layer-row ${selectedLayerTrack === 'v3-captions' ? 'is-selected' : ''}`}
                    style={{ height: 28 }}
                    onClick={() => setSelectedLayerTrack('v3-captions')}
                  >
                    <div className="nle-layer-header">
                      <span className="nle-layer-title">
                        <span style={{ color: '#a855f7', fontFamily: 'var(--font-mono)' }}>V3</span>
                        <span>Captions</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-icon"
                        style={{ width: 20, height: 20 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            hideCaptions: !c.hideCaptions,
                          }));
                        }}
                        title={activeClip.hideCaptions ? 'Show V3 Captions Layer' : 'Hide V3 Captions Layer'}
                      >
                        {activeClip.hideCaptions ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                    </div>
                    <div
                      className="nle-layer-track"
                      onMouseDown={(e) => {
                        setSelectedLayerTrack('v3-captions');
                        updateTimelineDragAtClientX(e.clientX, 'playhead');
                      }}
                    >
                      {activeClip.captions && activeClip.captions.length > 0 ? (
                        activeClip.captions.map((seg) => {
                          const dur = Math.max(0.5, activeClip.duration);
                          const leftPct = Math.max(0, Math.min(99, (seg.start / dur) * 100));
                          const widthPct = Math.max(
                            1.5,
                            Math.min(100 - leftPct, ((seg.end - seg.start) / dur) * 100)
                          );
                          const isSel =
                            selectedLayerTrack === 'v3-captions' && selectedCaptionId === seg.id;
                          return (
                            <div
                              key={seg.id}
                              className={`nle-layer-block ${isSel ? 'is-active' : ''}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedLayerTrack('v3-captions');
                                setSelectedCaptionId(seg.id);
                                handleSeekClipTime(seg.start);
                              }}
                              style={{
                                left: `${leftPct}%`,
                                width: `${widthPct}%`,
                                background: activeClip.hideCaptions
                                  ? 'rgba(113, 113, 122, 0.16)'
                                  : 'rgba(168, 85, 247, 0.28)',
                                border: '1px solid rgba(168, 85, 247, 0.72)',
                                color: '#f3e8ff',
                              }}
                              title={`${seg.start.toFixed(1)}s - ${seg.end.toFixed(1)}s: ${seg.text}`}
                            >
                              {seg.text}
                            </div>
                          );
                        })
                      ) : activeClip.captionText && activeClip.captionText.trim().length > 0 ? (
                        <div
                          className={`nle-layer-block ${selectedLayerTrack === 'v3-captions' ? 'is-active' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedLayerTrack('v3-captions');
                          }}
                          style={{
                            left: '0%',
                            width: '100%',
                            background: activeClip.hideCaptions
                              ? 'rgba(113, 113, 122, 0.16)'
                              : 'rgba(168, 85, 247, 0.25)',
                            border: '1px solid rgba(168, 85, 247, 0.65)',
                            color: '#f3e8ff',
                          }}
                        >
                          {activeClip.captionText}
                        </div>
                      ) : (
                        <span
                          style={{
                            fontSize: 9.5,
                            color: 'var(--text-muted)',
                            paddingLeft: 8,
                            alignSelf: 'center',
                            pointerEvents: 'none',
                          }}
                        >
                          No captions on V3 — click "Transcribe Captions" or "+ Caption (V3)"
                        </span>
                      )}

                      {/* Playhead needle */}
                      <div
                        style={{
                          position: 'absolute',
                          left: `${Math.max(0, Math.min(100, (clipPlayheadTime / Math.max(0.1, activeClip.duration)) * 100))}%`,
                          top: 0,
                          bottom: 0,
                          width: 2,
                          background: '#fafafa',
                          pointerEvents: 'none',
                          zIndex: 15,
                        }}
                      />
                    </div>
                  </div>

                  {/* LAYER V2: SPEAKER B / SPLIT-SCREEN LAYER */}
                  <div
                    className={`nle-layer-row ${selectedLayerTrack === 'v2-speaker' ? 'is-selected' : ''}`}
                    style={{ height: 26 }}
                    onClick={() => setSelectedLayerTrack('v2-speaker')}
                  >
                    <div className="nle-layer-header">
                      <span className="nle-layer-title">
                        <span style={{ color: '#f97316', fontFamily: 'var(--font-mono)' }}>V2</span>
                        <span>Speaker B</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-icon"
                        style={{ width: 20, height: 20 }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (activeClip.backgroundFillStyle === 'split-screen') {
                            updateActiveTimelineClip((c) => ({
                              ...c,
                              backgroundFillStyle: 'blurred',
                            }));
                          } else {
                            handleTwoSpeakerMode('split-screen');
                          }
                        }}
                        title="Toggle 2-Speaker Split-Screen Layer"
                      >
                        <Layers size={11} />
                      </button>
                    </div>
                    <div
                      className="nle-layer-track"
                      onMouseDown={(e) => {
                        setSelectedLayerTrack('v2-speaker');
                        updateTimelineDragAtClientX(e.clientX, 'playhead');
                      }}
                    >
                      {activeClip.backgroundFillStyle === 'split-screen' ||
                      activeClip.subjectFocus?.label === '2-Speaker Auto-Switch' ? (
                        <div
                          className={`nle-layer-block ${selectedLayerTrack === 'v2-speaker' ? 'is-active' : ''}`}
                          style={{
                            left: '0%',
                            width: '100%',
                            background: 'rgba(249, 115, 22, 0.25)',
                            border: '1px solid rgba(249, 115, 22, 0.7)',
                            color: '#ffedd5',
                          }}
                        >
                          {activeClip.backgroundFillStyle === 'split-screen'
                            ? `2-Speaker Split-Screen · A ${(activeClip.speakerAScale ?? 1).toFixed(2)}x / B ${(activeClip.speakerBScale ?? 1).toFixed(2)}x · Split ${Math.round((activeClip.splitScreenRatio ?? 0.5) * 100)}%`
                            : '2-Speaker Active Auto-Switch'}
                        </div>
                      ) : (
                        <span
                          style={{
                            fontSize: 9.5,
                            color: 'var(--text-muted)',
                            paddingLeft: 8,
                            alignSelf: 'center',
                            pointerEvents: 'none',
                          }}
                        >
                          Single-camera mode — click V2 icon or "2-Speaker Split-Screen" to enable dual-camera layer
                        </span>
                      )}

                      {/* Playhead needle */}
                      <div
                        style={{
                          position: 'absolute',
                          left: `${Math.max(0, Math.min(100, (clipPlayheadTime / Math.max(0.1, activeClip.duration)) * 100))}%`,
                          top: 0,
                          bottom: 0,
                          width: 2,
                          background: '#fafafa',
                          pointerEvents: 'none',
                          zIndex: 15,
                        }}
                      />
                    </div>
                  </div>

                  {/* LAYER V1: PRIMARY VIDEO CUTS TRACK */}
                  <div
                    className={`nle-layer-row ${selectedLayerTrack === 'v1-video' ? 'is-selected' : ''}`}
                    style={{ height: 36 }}
                    onClick={() => setSelectedLayerTrack('v1-video')}
                  >
                    <div className="nle-layer-header">
                      <span className="nle-layer-title">
                        <span style={{ color: '#3b82f6', fontFamily: 'var(--font-mono)' }}>V1</span>
                        <span>Video Cuts</span>
                      </span>
                      <span className="badge-subtle" style={{ fontSize: 9, padding: '0 4px' }}>
                        {activeClip.subCuts.length}
                      </span>
                    </div>

                    <div
                      ref={timelineBarRef}
                      className="nle-layer-track"
                      style={{
                        cursor: isRazorMode ? 'crosshair' : 'pointer',
                      }}
                      onMouseDown={(e) => {
                        setSelectedLayerTrack('v1-video');
                        if (!timelineBarRef.current || !activeClip) return;
                        const rect = timelineBarRef.current.getBoundingClientRect();
                        const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                        const clickedClipTime = ratio * activeClip.duration;

                        if (isRazorMode) {
                          handleRazorSplitAtClipTime(clickedClipTime);
                          return;
                        }

                        setDraggingHandle('playhead');
                        updateTimelineDragAtClientX(e.clientX, 'playhead');
                      }}
                      onMouseMove={(e) => {
                        if (timelineBarRef.current && activeClip) {
                          const rect = timelineBarRef.current.getBoundingClientRect();
                          const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                          setRazorHoverClipTime(ratio * activeClip.duration);
                        }
                        if (!draggingHandle || isRazorMode) return;
                        updateTimelineDragAtClientX(e.clientX, draggingHandle);
                      }}
                      onMouseUp={() => setDraggingHandle(null)}
                      onMouseLeave={() => {
                        setDraggingHandle(null);
                        setRazorHoverClipTime(null);
                      }}
                    >
                      {activeClip.subCuts.map((cut, idx) => {
                        const cutDur = Math.max(0.1, cut.timelineEnd - cut.timelineStart);
                        const widthPct = (cutDur / Math.max(0.5, activeClip.duration)) * 100;
                        const isCurrentCut =
                          clipPlayheadTime >= cut.timelineStart - 0.02 &&
                          clipPlayheadTime <= cut.timelineEnd + 0.02;
                        const isSelectedCut = idx === selectedCutIndex;

                        return (
                          <div
                            key={cut.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedLayerTrack('v1-video');
                              if (isRazorMode && timelineBarRef.current) {
                                const rect = timelineBarRef.current.getBoundingClientRect();
                                const ratio = Math.max(
                                  0,
                                  Math.min(1, (e.clientX - rect.left) / rect.width)
                                );
                                handleRazorSplitAtClipTime(ratio * activeClip.duration);
                                return;
                              }
                              setSelectedCutIndex(idx);
                              activeCutIdxRef.current = idx;
                              updateTimelineDragAtClientX(e.clientX, 'playhead');
                            }}
                            style={{
                              width: `${widthPct}%`,
                              height: '100%',
                              position: 'relative',
                              background: isSelectedCut
                                ? 'rgba(59, 130, 246, 0.26)'
                                : isCurrentCut
                                  ? 'rgba(59, 130, 246, 0.14)'
                                  : 'rgba(24, 24, 30, 0.9)',
                              borderRight:
                                idx < activeClip.subCuts.length - 1
                                  ? '1px solid var(--border-strong)'
                                  : 'none',
                              boxShadow: isSelectedCut
                                ? 'inset 0 0 0 1px rgba(59, 130, 246, 0.75)'
                                : 'none',
                              display: 'flex',
                              alignItems: 'center',
                              padding: '0 6px',
                              overflow: 'hidden',
                            }}
                          >
                            <span
                              style={{
                                fontSize: 9.5,
                                fontFamily: 'var(--font-mono)',
                                color: isSelectedCut ? '#fafafa' : 'var(--text-secondary)',
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                pointerEvents: 'none',
                              }}
                            >
                              {timelineMode === 'full-source' && activeClip.subCuts.length === 1
                                ? activeSource.name
                                : `${cut.label} (${cutDur.toFixed(1)}s)`}
                            </span>
                          </div>
                        );
                      })}

                      {/* In / Out Shaded Region */}
                      {inMarkerPct !== null && outMarkerPct !== null && outMarkerPct >= inMarkerPct && (
                        <>
                          <div
                            style={{
                              position: 'absolute',
                              left: `${inMarkerPct}%`,
                              width: `${Math.max(0.5, outMarkerPct - inMarkerPct)}%`,
                              top: 0,
                              bottom: 0,
                              background: 'rgba(250, 250, 250, 0.08)',
                              borderTop: '1px solid rgba(250, 250, 250, 0.5)',
                              borderBottom: '1px solid rgba(250, 250, 250, 0.5)',
                              pointerEvents: 'none',
                              zIndex: 5,
                            }}
                          />
                          <div
                            onMouseDown={(e) => {
                              if (isRazorMode) return;
                              e.stopPropagation();
                              setDraggingHandle('in');
                            }}
                            style={{
                              position: 'absolute',
                              left: `${inMarkerPct}%`,
                              top: 0,
                              bottom: 0,
                              width: 10,
                              transform: 'translateX(-50%)',
                              cursor: 'ew-resize',
                              zIndex: 12,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                            }}
                          >
                            <div style={{ flex: 1, width: 2, background: '#e4e4e7' }} />
                          </div>
                          <div
                            onMouseDown={(e) => {
                              if (isRazorMode) return;
                              e.stopPropagation();
                              setDraggingHandle('out');
                            }}
                            style={{
                              position: 'absolute',
                              left: `${outMarkerPct}%`,
                              top: 0,
                              bottom: 0,
                              width: 10,
                              transform: 'translateX(-50%)',
                              cursor: 'ew-resize',
                              zIndex: 12,
                              display: 'flex',
                              flexDirection: 'column',
                              alignItems: 'center',
                            }}
                          >
                            <div style={{ flex: 1, width: 2, background: '#e4e4e7' }} />
                          </div>
                        </>
                      )}

                      {/* Playhead Needle */}
                      <div
                        style={{
                          position: 'absolute',
                          left: `${Math.max(
                            0,
                            Math.min(
                              100,
                              (clipPlayheadTime / Math.max(0.1, activeClip.duration)) * 100
                            )
                          )}%`,
                          top: 0,
                          bottom: 0,
                          width: 2,
                          background: '#fafafa',
                          boxShadow: '0 0 6px rgba(255,255,255,0.8)',
                          pointerEvents: 'none',
                          zIndex: 15,
                        }}
                      />
                    </div>
                  </div>

                  {/* LAYER A1: SYNCHRONIZED AUDIO WAVEFORM LAYER */}
                  <div
                    className={`nle-layer-row ${selectedLayerTrack === 'a1-audio' ? 'is-selected' : ''}`}
                    style={{ height: 28 }}
                    onClick={() => setSelectedLayerTrack('a1-audio')}
                  >
                    <div className="nle-layer-header">
                      <span className="nle-layer-title">
                        <span style={{ color: '#10b981', fontFamily: 'var(--font-mono)' }}>A1</span>
                        <span>Audio</span>
                      </span>
                      <button
                        type="button"
                        className="btn btn-icon"
                        style={{
                          width: 20,
                          height: 20,
                          color: isMuted ? '#f87171' : '#34d399',
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          const nextMute = !isMuted;
                          setIsMuted(nextMute);
                          if (videoRef.current) videoRef.current.muted = nextMute;
                        }}
                        title={isMuted ? 'Unmute A1 Audio Layer' : 'Mute A1 Audio Layer'}
                      >
                        {isMuted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                      </button>
                    </div>
                    <div
                      className="nle-layer-track"
                      onMouseDown={(e) => {
                        setSelectedLayerTrack('a1-audio');
                        updateTimelineDragAtClientX(e.clientX, 'playhead');
                      }}
                    >
                      {activeClip.subCuts.map((cut) => {
                        const cutDur = Math.max(0.1, cut.timelineEnd - cut.timelineStart);
                        const widthPct = (cutDur / Math.max(0.5, activeClip.duration)) * 100;
                        const totalBuckets = activeSource.waveformPeaks.length;
                        const bStart = Math.max(
                          0,
                          Math.floor(
                            (cut.sourceStart / Math.max(1, activeSource.duration)) * totalBuckets
                          )
                        );
                        const bEnd = Math.max(
                          bStart + 2,
                          Math.ceil((cut.sourceEnd / Math.max(1, activeSource.duration)) * totalBuckets)
                        );
                        const slicePeaks = activeSource.waveformPeaks.slice(bStart, bEnd);
                        return (
                          <div
                            key={`audio-${cut.id}`}
                            style={{
                              width: `${widthPct}%`,
                              height: '100%',
                              display: 'flex',
                              alignItems: 'flex-end',
                              gap: 1,
                              padding: '0 2px',
                              opacity: isMuted ? 0.3 : 1,
                            }}
                          >
                            {slicePeaks.map((pk, pIdx) => (
                              <div
                                key={pIdx}
                                style={{
                                  flex: 1,
                                  height: `${Math.max(12, Math.round(pk * 82))}%`,
                                  background: isMuted
                                    ? 'rgba(239, 68, 68, 0.35)'
                                    : 'rgba(16, 185, 129, 0.48)',
                                  pointerEvents: 'none',
                                }}
                              />
                            ))}
                          </div>
                        );
                      })}

                      {/* Playhead needle */}
                      <div
                        style={{
                          position: 'absolute',
                          left: `${Math.max(0, Math.min(100, (clipPlayheadTime / Math.max(0.1, activeClip.duration)) * 100))}%`,
                          top: 0,
                          bottom: 0,
                          width: 2,
                          background: '#fafafa',
                          pointerEvents: 'none',
                          zIndex: 15,
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* CONTEXT-AWARE ACTIVE LAYER INSPECTOR (V4 Overlays / V3 Captions / V2 Speaker B / V1 Video Cuts) */}
                {selectedLayerTrack === 'v4-overlay' ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 10,
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                      paddingTop: 2,
                    }}
                  >
                    <span className="badge-subtle" style={{ color: '#fbbf24' }}>
                      V4 Overlay Layer Inspector
                    </span>

                    {(() => {
                      const activeCustomLayer = (activeClip.overlayLayers || []).find(
                        (l) => l.id === selectedOverlayLayerId
                      );
                      if (activeCustomLayer) {
                        return (
                          <>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 160 }}>
                              <span>Text</span>
                              <input
                                type="text"
                                className="input-field"
                                style={{ height: 24 }}
                                value={activeCustomLayer.text}
                                onChange={(e) => {
                                  const val = e.target.value;
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    overlayLayers: (c.overlayLayers || []).map((ly) =>
                                      ly.id === activeCustomLayer.id ? { ...ly, text: val } : ly
                                    ),
                                  }));
                                }}
                              />
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span>Scale</span>
                              <input
                                type="range"
                                min={0.5}
                                max={2.5}
                                step={0.05}
                                value={activeCustomLayer.scale || 1.0}
                                onChange={(e) => {
                                  const sc = parseFloat(e.target.value);
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    overlayLayers: (c.overlayLayers || []).map((ly) =>
                                      ly.id === activeCustomLayer.id ? { ...ly, scale: sc } : ly
                                    ),
                                  }));
                                }}
                                style={{ width: 64 }}
                              />
                              <span className="badge-subtle">
                                {Math.round((activeCustomLayer.scale || 1) * 100)}%
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                              <span>Start</span>
                              <input
                                type="range"
                                min={0}
                                max={Math.max(0.2, activeCustomLayer.endTime - 0.3)}
                                step={0.1}
                                value={activeCustomLayer.startTime}
                                onChange={(e) => {
                                  const st = parseFloat(e.target.value);
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    overlayLayers: (c.overlayLayers || []).map((ly) =>
                                      ly.id === activeCustomLayer.id ? { ...ly, startTime: st } : ly
                                    ),
                                  }));
                                }}
                                style={{ width: 56 }}
                              />
                              <span>End</span>
                              <input
                                type="range"
                                min={Math.min(activeClip.duration, activeCustomLayer.startTime + 0.3)}
                                max={activeClip.duration}
                                step={0.1}
                                value={activeCustomLayer.endTime}
                                onChange={(e) => {
                                  const et = parseFloat(e.target.value);
                                  updateActiveTimelineClip((c) => ({
                                    ...c,
                                    overlayLayers: (c.overlayLayers || []).map((ly) =>
                                      ly.id === activeCustomLayer.id ? { ...ly, endTime: et } : ly
                                    ),
                                  }));
                                }}
                                style={{ width: 56 }}
                              />
                            </div>
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => {
                                updateActiveTimelineClip((c) => ({
                                  ...c,
                                  overlayLayers: (c.overlayLayers || []).filter(
                                    (ly) => ly.id !== activeCustomLayer.id
                                  ),
                                }));
                                setSelectedOverlayLayerId('__banner__');
                              }}
                            >
                              <Trash2 size={11} />
                              Delete Layer
                            </button>
                          </>
                        );
                      }

                      return (
                        <>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 180 }}>
                            <span>Title Banner</span>
                            <input
                              type="text"
                              className="input-field"
                              style={{ height: 24 }}
                              placeholder="Type top hook banner text..."
                              value={activeClip.overlayBannerText || ''}
                              onChange={(e) =>
                                updateActiveTimelineClip((c) => ({
                                  ...c,
                                  hideBannerLayer: false,
                                  overlayBannerText: e.target.value,
                                }))
                              }
                            />
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span>Banner Scale</span>
                            <input
                              type="range"
                              min={0.55}
                              max={2.4}
                              step={0.05}
                              value={activeClip.overlayBannerScale ?? 1.0}
                              onChange={(e) =>
                                updateActiveTimelineClip((c) => ({
                                  ...c,
                                  overlayBannerScale: parseFloat(e.target.value),
                                }))
                              }
                              style={{ width: 68 }}
                            />
                            <span className="badge-subtle">
                              {Math.round((activeClip.overlayBannerScale ?? 1) * 100)}%
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span>Y Pos</span>
                            <input
                              type="range"
                              min={0.08}
                              max={0.9}
                              step={0.01}
                              value={activeClip.overlayBannerPositionY ?? 0.14}
                              onChange={(e) =>
                                updateActiveTimelineClip((c) => ({
                                  ...c,
                                  overlayBannerPositionY: parseFloat(e.target.value),
                                }))
                              }
                              style={{ width: 64 }}
                            />
                          </div>
                        </>
                      );
                    })()}
                  </div>
                ) : selectedLayerTrack === 'v3-captions' ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 10,
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                      paddingTop: 2,
                    }}
                  >
                    <span className="badge-subtle" style={{ color: '#c084fc' }}>
                      V3 Captions Layer Inspector
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, flex: 1, minWidth: 180 }}>
                      <span>Caption Text</span>
                      <input
                        type="text"
                        className="input-field"
                        style={{ height: 24 }}
                        placeholder="Caption text..."
                        value={
                          (activeClip.captions || []).find((s) => s.id === selectedCaptionId)?.text ??
                          activeClip.captionText
                        }
                        onChange={(e) => {
                          const val = e.target.value;
                          updateActiveTimelineClip((c) => {
                            if (selectedCaptionId && c.captions?.some((s) => s.id === selectedCaptionId)) {
                              return {
                                ...c,
                                captions: c.captions.map((s) =>
                                  s.id === selectedCaptionId
                                    ? {
                                        ...s,
                                        text: val,
                                        words: val
                                          .split(/\s+/)
                                          .filter(Boolean)
                                          .map((w, idx, arr) => {
                                            const segDur = Math.max(0.2, s.end - s.start);
                                            const wDur = segDur / Math.max(1, arr.length);
                                            return {
                                              word: w,
                                              start: s.start + idx * wDur,
                                              end: s.start + (idx + 1) * wDur,
                                            };
                                          }),
                                      }
                                    : s
                                ),
                              };
                            }
                            return { ...c, captionText: val };
                          });
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span>Scale</span>
                      <input
                        type="range"
                        min={0.55}
                        max={2.2}
                        step={0.05}
                        value={activeClip.captionFontScale ?? 1.0}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            captionFontScale: parseFloat(e.target.value),
                          }))
                        }
                        style={{ width: 68 }}
                      />
                      <span className="badge-subtle">
                        {Math.round((activeClip.captionFontScale ?? 1) * 100)}%
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span>X</span>
                      <input
                        type="range"
                        min={0.15}
                        max={0.85}
                        step={0.01}
                        value={activeClip.captionPositionX ?? 0.5}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            captionPositionX: parseFloat(e.target.value),
                          }))
                        }
                        style={{ width: 54 }}
                      />
                      <span>Y</span>
                      <input
                        type="range"
                        min={0.1}
                        max={0.9}
                        step={0.01}
                        value={activeClip.captionPositionY ?? 0.77}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            captionPositionY: parseFloat(e.target.value),
                          }))
                        }
                        style={{ width: 54 }}
                      />
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setIsTranscriptEditorOpen(true)}
                    >
                      <FileText size={11} />
                      Edit Full Transcript
                    </button>
                  </div>
                ) : selectedLayerTrack === 'v2-speaker' ? (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      flexWrap: 'wrap',
                      gap: 10,
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                      paddingTop: 2,
                    }}
                  >
                    <span className="badge-subtle" style={{ color: '#fb923c' }}>
                      V2 Speaker B / Split-Screen Layer Inspector
                    </span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span>Speaker A Scale</span>
                      <input
                        type="range"
                        min={0.55}
                        max={2.4}
                        step={0.05}
                        value={activeClip.speakerAScale ?? 1.0}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            speakerAScale: parseFloat(e.target.value),
                          }))
                        }
                        style={{ width: 68 }}
                      />
                      <span className="badge-subtle">
                        {(activeClip.speakerAScale ?? 1.0).toFixed(2)}x
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span>Speaker B Scale</span>
                      <input
                        type="range"
                        min={0.55}
                        max={2.4}
                        step={0.05}
                        value={activeClip.speakerBScale ?? 1.0}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            speakerBScale: parseFloat(e.target.value),
                          }))
                        }
                        style={{ width: 68 }}
                      />
                      <span className="badge-subtle">
                        {(activeClip.speakerBScale ?? 1.0).toFixed(2)}x
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span>Top/Bottom Split Ratio</span>
                      <input
                        type="range"
                        min={0.25}
                        max={0.75}
                        step={0.01}
                        value={activeClip.splitScreenRatio ?? 0.5}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({
                            ...c,
                            splitScreenRatio: parseFloat(e.target.value),
                          }))
                        }
                        style={{ width: 68 }}
                      />
                      <span className="badge-subtle">
                        {Math.round((activeClip.splitScreenRatio ?? 0.5) * 100)}% /{' '}
                        {Math.round((1 - (activeClip.splitScreenRatio ?? 0.5)) * 100)}%
                      </span>
                    </div>
                  </div>
                ) : timelineMode === 'full-source' && activeClip.subCuts.length === 1 ? (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr',
                      gap: 10,
                      alignItems: 'center',
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                        In {(inMarker ?? 0).toFixed(1)}s
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={Math.max(
                          0.5,
                          (outMarker ?? activeSource.duration) - 0.5
                        )}
                        step={0.1}
                        value={inMarker ?? 0}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setInMarker(v);
                          handleSeekSourceTime(v);
                        }}
                        style={{ flex: 1 }}
                      />
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
                        Out {(outMarker ?? activeSource.duration).toFixed(1)}s
                      </span>
                      <input
                        type="range"
                        min={Math.min(activeSource.duration, (inMarker ?? 0) + 0.5)}
                        max={activeSource.duration}
                        step={0.1}
                        value={outMarker ?? activeSource.duration}
                        onChange={(e) => {
                          const v = parseFloat(e.target.value);
                          setOutMarker(v);
                          handleSeekSourceTime(v);
                        }}
                        style={{ flex: 1 }}
                      />
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ whiteSpace: 'nowrap' }}>Caption</span>
                      <input
                        type="text"
                        className="input-field"
                        style={{ height: 24 }}
                        placeholder="Overlay caption..."
                        value={activeClip.captionText}
                        onChange={(e) =>
                          updateActiveTimelineClip((c) => ({ ...c, captionText: e.target.value }))
                        }
                      />
                    </div>
                  </div>
                ) : (
                  inspectedCut && (
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr 1fr',
                        gap: 10,
                        alignItems: 'center',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>Cut #{inspectedCut.index} In</span>
                        <input
                          type="range"
                          min={0}
                          max={Math.max(0.5, inspectedCut.sourceEnd - 0.5)}
                          step={0.1}
                          value={inspectedCut.sourceStart}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!Number.isFinite(val)) return;
                            const clamped = Math.max(
                              0,
                              Math.min(inspectedCut.sourceEnd - 0.5, val)
                            );
                            updateActiveTimelineClip((c) => {
                              const updatedCuts = c.subCuts.map((sc) =>
                                sc.id === inspectedCut.id ? { ...sc, sourceStart: clamped } : sc
                              );
                              const recalc = recalculateClipTimeline(updatedCuts);
                              return {
                                ...c,
                                subCuts: recalc.subCuts,
                                duration: recalc.duration,
                                sourceStart: recalc.sourceStart,
                                sourceEnd: recalc.sourceEnd,
                              };
                            });
                            handleSeekSourceTime(clamped);
                          }}
                          style={{ flex: 1 }}
                        />
                        <span className="badge-subtle">
                          {inspectedCut.sourceStart.toFixed(1)}s
                        </span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>Out</span>
                        <input
                          type="range"
                          min={Math.min(activeSource.duration, inspectedCut.sourceStart + 0.5)}
                          max={activeSource.duration}
                          step={0.1}
                          value={inspectedCut.sourceEnd}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!Number.isFinite(val)) return;
                            const clamped = Math.max(
                              inspectedCut.sourceStart + 0.5,
                              Math.min(activeSource.duration, val)
                            );
                            updateActiveTimelineClip((c) => {
                              const updatedCuts = c.subCuts.map((sc) =>
                                sc.id === inspectedCut.id ? { ...sc, sourceEnd: clamped } : sc
                              );
                              const recalc = recalculateClipTimeline(updatedCuts);
                              return {
                                ...c,
                                subCuts: recalc.subCuts,
                                duration: recalc.duration,
                                sourceStart: recalc.sourceStart,
                                sourceEnd: recalc.sourceEnd,
                              };
                            });
                            handleSeekSourceTime(clamped);
                          }}
                          style={{ flex: 1 }}
                        />
                        <span className="badge-subtle">{inspectedCut.sourceEnd.toFixed(1)}s</span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ whiteSpace: 'nowrap' }}>Caption</span>
                        <input
                          type="text"
                          className="input-field"
                          style={{ height: 24 }}
                          placeholder="Overlay caption..."
                          value={activeClip.captionText}
                          onChange={(e) =>
                            updateActiveTimelineClip((c) => ({ ...c, captionText: e.target.value }))
                          }
                        />
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </section>

          {/* Right Vertical Resizable Splitter */}
          <div
            className={`studio-splitter-v ${resizingPane === 'right' ? 'is-dragging' : ''}`}
            onMouseDown={() => setResizingPane('right')}
            onDoubleClick={() => setRightPanelWidth(315)}
            title="Drag to resize Right Assistant Panel (double-click to reset)"
          />

          {/* RIGHT PANEL: Assistant */}
          <aside
            className="studio-panel"
            onPaste={handleChatPaste}
            onDragOver={(e) => {
              e.preventDefault();
              if (!isDraggingChatFile) setIsDraggingChatFile(true);
            }}
            onDragLeave={() => setIsDraggingChatFile(false)}
            onDrop={(e) => {
              e.preventDefault();
              setIsDraggingChatFile(false);
              if (e.dataTransfer?.files?.length) {
                handleAddFilesToChat(e.dataTransfer.files);
              }
            }}
            style={{
              outline: isDraggingChatFile ? '1px dashed var(--border-focus)' : undefined,
              outlineOffset: -4,
            }}
          >
            <input
              ref={chatAttachmentInputRef}
              type="file"
              multiple
              accept="image/*,video/*,.txt,.srt,.md,.json,.csv"
              style={{ display: 'none' }}
              onChange={(e) => {
                if (e.target.files) {
                  handleAddFilesToChat(e.target.files);
                  e.target.value = '';
                }
              }}
            />

            <div className="studio-panel-header">
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Bot size={13} color="var(--text-secondary)" />
                Assistant
              </span>
              <span className="badge-subtle">
                {aiSettings.models[aiSettings.activeProvider] || aiSettings.activeProvider}
              </span>
            </div>

            {/* Messages */}
            <div
              style={{
                flex: 1,
                overflowY: 'auto',
                padding: 10,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {chatMessages.map((msg) => (
                <div
                  key={msg.id}
                  style={{
                    alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '92%',
                    padding: '8px 10px',
                    borderRadius: 6,
                    background:
                      msg.role === 'user' ? 'var(--bg-elevated)' : 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: 11.5,
                    lineHeight: 1.45,
                  }}
                >
                  {msg.attachments && msg.attachments.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        marginBottom: 6,
                      }}
                    >
                      {msg.attachments.map((att) => (
                        <div
                          key={att.id}
                          style={{
                            borderRadius: 4,
                            overflow: 'hidden',
                            border: '1px solid var(--border-subtle)',
                            background: 'var(--bg-input)',
                            maxWidth: 160,
                          }}
                        >
                          {att.dataUrl ? (
                            <img
                              src={att.dataUrl}
                              alt={att.name}
                              style={{
                                display: 'block',
                                width: '100%',
                                maxHeight: 96,
                                objectFit: 'cover',
                              }}
                            />
                          ) : null}
                          <div
                            style={{
                              padding: '2px 6px',
                              fontSize: 10,
                              color: 'var(--text-secondary)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 4,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }}
                          >
                            {att.kind === 'image' ? (
                              <ImageIcon size={10} />
                            ) : att.kind === 'video' ? (
                              <Film size={10} />
                            ) : (
                              <FileText size={10} />
                            )}
                            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                              {att.name}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}

                  <div style={{ color: 'var(--text-main)', whiteSpace: 'pre-line' }}>
                    {sanitizeCleanText(msg.content)}
                  </div>

                  {msg.operationBadges && msg.operationBadges.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 4,
                        marginTop: 6,
                        alignItems: 'center',
                      }}
                    >
                      {msg.operationBadges.map((b, i) => (
                        <span key={i} className="badge-subtle">
                          {sanitizeCleanText(b)}
                        </span>
                      ))}

                      {msg.revisionSnapshotId && (
                        <button
                          className="btn btn-sm"
                          style={{ height: 20, padding: '0 6px', marginLeft: 'auto' }}
                          onClick={() => handleRevertSnapshot(msg.revisionSnapshotId!)}
                        >
                          <RotateCcw size={10} />
                          Undo
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {isCopilotBusy && (
                <div
                  style={{
                    alignSelf: 'flex-start',
                    padding: '7px 10px',
                    borderRadius: 6,
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-subtle)',
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                  }}
                >
                  Applying changes...
                </div>
              )}
            </div>

            {/* Pending Attachments */}
            {pendingChatAttachments.length > 0 && (
              <div
                style={{
                  padding: '6px 10px',
                  borderTop: '1px solid var(--border-subtle)',
                  background: 'var(--bg-panel-header)',
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                {pendingChatAttachments.map((att) => (
                  <div
                    key={att.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '2px 6px',
                      borderRadius: 4,
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border-subtle)',
                      fontSize: 10.5,
                      color: 'var(--text-secondary)',
                      maxWidth: 160,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        flex: 1,
                      }}
                    >
                      {att.name}
                    </span>
                    <button
                      type="button"
                      onClick={() =>
                        setPendingChatAttachments((prev) => prev.filter((p) => p.id !== att.id))
                      }
                      style={{
                        background: 'none',
                        border: 'none',
                        color: 'var(--text-muted)',
                        cursor: 'pointer',
                        display: 'flex',
                      }}
                    >
                      <X size={11} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Chat Input */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if ((!chatInput.trim() && pendingChatAttachments.length === 0) || isCopilotBusy)
                  return;
                handleSendChat(chatInput);
                setChatInput('');
              }}
              style={{
                padding: 8,
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                gap: 6,
                background: 'var(--bg-panel-header)',
                alignItems: 'center',
              }}
            >
              <button
                type="button"
                className="btn btn-icon"
                onClick={() => chatAttachmentInputRef.current?.click()}
                disabled={isCopilotBusy}
                title="Attach reference"
              >
                <Paperclip size={13} />
              </button>
              <input
                type="text"
                className="input-field"
                placeholder="Ask assistant..."
                value={chatInput}
                onPaste={handleChatPaste}
                onChange={(e) => setChatInput(e.target.value)}
              />
              <button
                type="submit"
                className="btn btn-primary btn-icon"
                disabled={
                  (!chatInput.trim() && pendingChatAttachments.length === 0) || isCopilotBusy
                }
              >
                <CornerDownLeft size={13} />
              </button>
            </form>
          </aside>
        </main>

        {/* Modals */}
        <ProjectsModal
          isOpen={isProjectsModalOpen}
          currentProjectId={currentProjectId}
          currentProjectName={currentProjectName}
          hasActiveVideo={Boolean(activeSource)}
          isSaving={isSavingProject}
          onClose={() => setIsProjectsModalOpen(false)}
          onSaveCurrentProject={handleSaveCurrentProject}
          onRecallProject={handleRecallProject}
        />

        <AISettingsModal
          isOpen={isAISettingsOpen}
          settings={aiSettings}
          serverAIStatus={serverAIStatus}
          onClose={() => setIsAISettingsOpen(false)}
          onSave={(updated) => {
            setAiSettings(updated);
            saveAISettings(updated);
          }}
        />

        <TranscriptEditorModal
          isOpen={isTranscriptEditorOpen}
          activeClip={activeClip}
          activeSource={activeSource}
          clipPlayheadTime={clipPlayheadTime}
          isTranscribing={isTranscribingAudio}
          transcriptionProgress={transcriptionProgress}
          onClose={() => setIsTranscriptEditorOpen(false)}
          onUpdateClipCaptions={(captions, fallbackText) => {
            updateActiveTimelineClip((c) => ({
              ...c,
              hideCaptions: false,
              captions,
              captionText: fallbackText ?? captions[0]?.text ?? c.captionText,
            }));
          }}
          onUpdateSourceTranscript={(segments) => {
            setActiveSource((prev) =>
              prev ? { ...prev, transcriptSegments: segments } : prev
            );
          }}
          onSeekClipTime={handleSeekClipTime}
          onSeekSourceTime={handleSeekSourceTime}
          onRunAITranscription={handleRunAITranscription}
        />
      </div>
    </Tooltip.Provider>
  );
};

export default App;
