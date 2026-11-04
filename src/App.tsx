import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  CornerDownLeft,
  Crosshair,
  Download,
  FileText,
  Film,
  Flame,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Lock,
  LogOut,
  Paperclip,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Sparkles,
  Trash2,
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
} from './types/editor';
import {
  applyTwoSpeakerEditMode,
  buildWordLevelCaptionsFromText,
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
import {
  ComplexAuthUser,
  getLastActiveProjectId,
  loadSavedAuthUser,
  recallStudioProject,
  saveStudioProject,
  signOutComplexUser,
  tryUploadVideoToVercelBlob,
} from './services/projectStorage';

const QUICK_FEEDBACK_CHIPS = [
  'Remove all dead air & silent pauses',
  'Add word-by-word karaoke captions',
  '2-speaker top/bottom split screen',
  'Auto-switch between left & right speakers',
  'Fit 16:9 with blurred 9:16 background',
  'Remove all zoom (1.0x across timeline)',
  'Sync cuts to audio beats',
  'Speed up to 1.25x',
];

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
    return s > 0 ? `${m}m ${s}s (${seconds}s)` : `${m}m (${seconds}s)`;
  }
  return `${seconds}s`;
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

  // 6. Progress & Busy States
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisStatus, setAnalysisStatus] = useState<string>('');
  const [isCloningRef, setIsCloningRef] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [isTranscribingAudio, setIsTranscribingAudio] = useState<boolean>(false);

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
      content:
        'Gemini 4 Argon Studio Agent is live! You can paste screenshots/images (Ctrl+V), drag & drop reference files, or click 📎 to attach images, reference videos, or scripts. Ask me to lock onto any object, match a reference style, generate clips, or edit your timeline.',
      timestamp: new Date().toISOString(),
      providerBadge: 'gemini-4-argon [Live]',
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
  }, [render9x16Preview, playheadTime, clipPlayheadTime, liveTrackedAnchor]);

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
      let anchorX = 0.5;
      let anchorY = 0.48;
      let label = 'Auto Salient Subject';

      if (strategy === 'left-subject') {
        anchorX = currentTrack.leftSubjectX ?? 0.3;
        label = 'Left Subject Focus';
      } else if (strategy === 'right-subject') {
        anchorX = currentTrack.rightSubjectX ?? 0.7;
        label = 'Right Subject Focus';
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

      if ( strategy !== 'click-track') {
        userFocusAnchorsRef.current = [];
      }

      applySubjectFocusConfig({
        strategy,
        anchorX,
        anchorY,
        anchorTime: playheadTime,
        label,
      });

      setMarkerNotice(`9:16 Subject Focus set to: ${label}`);
      setTimeout(() => setMarkerNotice(null), 2400);
    },
    [currentTrack, playheadTime, applySubjectFocusConfig]
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
                ? `🎯 Smoothly strung together ${totalLocks} Focus Lock Points across the timeline!`
                : `🎯 Locked #1 @ ${clickTime.toFixed(1)}s — Play or scrub ahead on the timeline and click the object again to add Lock #2, #3!`
            );
            setTimeout(() => setMarkerNotice(null), 4000);
          }
        })
        .catch(() => {})
        .finally(() => {
          setIsSolvingObjectTrack(false);
          setObjectTrackProgress(0);
        });
    }
  };

  // Click or Drag directly on the Source Video to pick ANY object and track it across the clip!
  const handlePointerOnSourceVideo = (
    e: React.MouseEvent<HTMLDivElement>,
    runFullTrajectorySolve = false
  ) => {
    if (!sourceOverlayWrapRef.current || !activeClip) return;
    const rect = sourceOverlayWrapRef.current.getBoundingClientRect();
    const normX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0.06, Math.min(0.94, (e.clientY - rect.top) / rect.height));
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
        setMarkerNotice(`✂ Razor cut at ${targetClipTime.toFixed(2)}s`);
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

  // Generate Best Viral Clips or Compilation Cutdowns from the Full Uploaded Video and immediately open #1 on the timeline!
  const handleGenerateClipsFromFullVideo = useCallback(
    async (modeOverride?: ClipCreationMode, customScheme?: EditingScheme) => {
      if (!activeSource) return;
      const baseScheme = customScheme || activeScheme;
      const mode: ClipCreationMode = modeOverride || baseScheme.clipCreationMode || 'clip-segment';
      const targetScheme: EditingScheme = {
        ...baseScheme,
        clipCreationMode: mode,
      };
      setActiveScheme(targetScheme);

      const currentFocus = activeClip?.subjectFocus;
      const freshClips = generateClipsFromScheme(activeSource, targetScheme).map((c) =>
        currentFocus ? { ...c, subjectFocus: currentFocus } : c
      );
      setGeneratedClips(freshClips);
      if (freshClips[0]) {
        selectClip(freshClips[0]);
      }

      const modeLabel =
        mode === 'condensed-edit' ? 'Compilation Cutdowns' : 'Best Viral Clips';
      setMarkerNotice(
        `Generated ${freshClips.length} ${modeLabel} (${targetScheme.targetClipDuration}s target) & loaded #1 on timeline!`
      );
      setTimeout(() => setMarkerNotice(null), 3500);

      // Also query AI in background if API key is configured
      const aiRes = await generateClipsWithMultimodalAI(activeSource, targetScheme, aiSettings);
      if (aiRes.clips && aiRes.clips.length > 0) {
        const withFocus = aiRes.clips.map((c) =>
          currentFocus ? { ...c, subjectFocus: currentFocus } : c
        );
        setGeneratedClips(withFocus);
        selectClip(withFocus[0]);
      }
    },
    [activeSource, activeScheme, aiSettings, selectClip, activeClip?.subjectFocus]
  );

  // Keyboard shortcuts: Space (Play/Pause), C (Razor Blade Toggle), I (Set In), O (Set Out), Delete/Backspace (Delete Selected Cut)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay(false);
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

  // Upload & Analyze Real Video — Loads the Full Uploaded Video onto the timeline with NO automatic clipping!
  const handleUploadVideoFile = async (file: File) => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    setIsLoopingInOut(false);
    setIsAnalyzing(true);
    setAnalysisStatus('Loading video & decoding audio...');

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

      setChatMessages((prev) => [
        ...prev,
        {
          id: `upload-ready-${Date.now()}`,
          role: 'assistant',
          content: `Loaded "${file.name}" (${analyzed.width}×${analyzed.height}, ${analyzed.duration}s) onto the timeline. Nothing was clipped automatically — you can now pick your Subject Focus on the video, or click "Find Best Viral Clips" or "Generate Compilation Cutdowns" whenever you're ready.`,
          timestamp: new Date().toISOString(),
          providerBadge: 'Video Ready',
          operationBadges: ['Full Video on Timeline', `${analyzed.duration}s`],
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
      setChatMessages(st.chatMessages);
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
      const currentFocus = activeClip?.subjectFocus;
      const fresh = generateClipsFromScheme(activeSource, targetScheme).map((c) =>
        currentFocus ? { ...c, subjectFocus: currentFocus } : c
      );
      setGeneratedClips(fresh);
      if (fresh[0]) {
        selectClip(fresh[0]);
      }
      setSchemeSavedNotice(
        `Generated ${fresh.length} ${
          targetScheme.clipCreationMode === 'condensed-edit'
            ? 'Compilation Cutdowns'
            : 'Viral Clips'
        } (${targetScheme.targetClipDuration}s)!`
      );
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

  // Run Real AI Speech-to-Text Transcription on the Active Clip's Audio Track
  const handleRunAITranscription = useCallback(async () => {
    if (!activeClip || !activeSource || isTranscribingAudio) return;
    setIsTranscribingAudio(true);
    setMarkerNotice('🎙️ Extracting audio & transcribing speech with Gemini 4 Argon...');

    try {
      const res = await transcribeClipAudioWithAI({
        clip: activeClip,
        source: activeSource,
        videoBlob: uploadedVideoBlobRef.current,
        aiSettings,
        clipPlayheadTime,
        onStatus: (msg) => setMarkerNotice(msg),
      });

      if (res.captions.length > 0) {
        updateActiveTimelineClip((c) => ({
          ...c,
          captions: res.captions,
          captionText: res.captions[0]?.text || c.captionText,
        }));
        const previewLines = res.captions
          .slice(0, 4)
          .map((c) => `"${c.text}"`)
          .join(' → ');
        setMarkerNotice(
          `✅ Transcribed ${res.captions.length} word-level karaoke cards (${res.providerUsed})!`
        );
        setChatMessages((prev) => [
          ...prev,
          {
            id: `transcribed-${Date.now()}`,
            role: 'assistant',
            content: `Transcribed real speech from your video into ${res.captions.length} word-by-word karaoke caption cards: ${previewLines}${res.captions.length > 4 ? ' ...' : ''}`,
            timestamp: new Date().toISOString(),
            providerBadge: res.providerUsed,
            liveApiUsed: true,
            operationBadges: [`🎤 ${res.captions.length} Word Karaoke Cards`, 'Real Audio STT'],
          },
        ]);
      } else {
        setMarkerNotice(`⚠️ ${res.error || 'No speech detected in this audio segment.'}`);
      }
    } catch (err: any) {
      setMarkerNotice(`⚠️ Audio transcription failed: ${err?.message || 'Error'}`);
    } finally {
      setIsTranscribingAudio(false);
      setTimeout(() => setMarkerNotice(null), 4200);
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

      // If the user is asking for transcription/captions/karaoke, extract the real WAV audio slice so Gemini hears it!
      let extractedAudio: {
        wavBase64: string | null;
        startClipTime: number;
        extractedDuration: number;
      } | null = null;
      if (
        activeClip &&
        activeSource &&
        /\b(caption|captions|subtitle|subtitles|transcribe|karaoke|word[\s-]by[\s-]word|what\s+are\s+they\s+saying)\b/i.test(
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
                captionText: activeClip.captionText,
                subjectFocusLabel: activeClip.subjectFocus?.label,
                cuts: activeClip.subCuts.map((c) => ({
                  id: c.id,
                  timeOffset: c.timelineStart,
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

      // 2. Handle Multimodal Clip Generation
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
        handleGenerateClipsFromFullVideo(nextMode, schemeAfterOps);
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
              `🎯 Locked: ${op.targetLabel || 'Object'} (${Math.round(op.focusX * 100)}%, ${Math.round(op.focusY * 100)}%)`
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
            } else if (op.type === 'generate_word_captions') {
              if (op.captionStyle) {
                next.captionStyle = op.captionStyle;
              }
              if (Array.isArray(op.captionSegments) && op.captionSegments.length > 0) {
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
              } else if (op.captionText) {
                next.captions = buildWordLevelCaptionsFromText(
                  op.captionText,
                  next.duration,
                  4,
                  clipPlayheadTime
                );
                next.captionText = op.captionText;
              } else {
                // Trigger real audio transcription asynchronously!
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

      {/* Clean Top Header Bar */}
      <header className="studio-topbar">
        <div className="studio-brand">
          <div
            style={{
              width: 30,
              height: 30,
              borderRadius: 7,
              background: 'rgba(45, 140, 235, 0.16)',
              border: '1px solid rgba(96, 165, 250, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Scissors size={15} color="#60a5fa" />
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.2px' }}>
              ClipMaker Studio
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              Viral Clip Finder • Compilation Cutdowns • 9:16 Subject Focus Lock
            </div>
          </div>
        </div>

        {/* Center Status Banner when Analyzing or Cloning */}
        {(isAnalyzing || isCloningRef) && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              background: 'rgba(45, 140, 235, 0.15)',
              border: '1px solid rgba(45, 140, 235, 0.45)',
              padding: '6px 14px',
              borderRadius: 6,
              color: '#93c5fd',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            <Sparkles size={14} />
            <span>{analysisStatus || 'Processing video...'}</span>
          </div>
        )}

        {/* Right Controls: Projects, Upload Video, Clone Reference Style, AI Provider Switcher, Export, @complex.com User */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Saved Projects Library & Quick Save Button */}
          <button
            className="btn"
            onClick={() => setIsProjectsModalOpen(true)}
            style={{
              borderColor: 'rgba(52, 211, 153, 0.45)',
              background: 'rgba(16, 185, 129, 0.14)',
              color: '#a7f3d0',
              fontWeight: 600,
            }}
            title="Open Saved Projects Library to save or recall any project"
          >
            <FolderOpen size={14} color="#34d399" />
            Projects
          </button>

          {activeSource && (
            <button
              className="btn"
              onClick={() => handleSaveCurrentProject(currentProjectName, false)}
              disabled={isSavingProject}
              title={`Save project "${currentProjectName}" (Auto-saves as you edit)`}
            >
              <Save size={13} color="#60a5fa" />
              {isSavingProject ? 'Saving...' : 'Save'}
            </button>
          )}

          <button
            className="btn"
            onClick={() => sourceFileInputRef.current?.click()}
            disabled={isAnalyzing}
          >
            <Upload size={14} color="#60a5fa" />
            {activeSource ? 'Upload Video' : 'Upload Video'}
          </button>

          <button
            className="btn btn-purple"
            onClick={() => referenceFileInputRef.current?.click()}
            disabled={isCloningRef}
            title="Upload any reference video to copy its cut speed and zoom style into a new Editing Scheme"
          >
            <Wand2 size={14} />
            Clone Style
          </button>

          {/* AI Provider Pill Switcher (Gemini default, Claude, OpenAI) */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              background: 'var(--bg-input)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 6,
              padding: 3,
              gap: 3,
            }}
          >
            {(['gemini', 'claude', 'openai'] as AIProviderId[]).map((prov) => {
              const active = aiSettings.activeProvider === prov;
              const envReady =
                (prov === 'gemini' && serverAIStatus.geminiConfigured) ||
                (prov === 'claude' && serverAIStatus.claudeConfigured) ||
                (prov === 'openai' && serverAIStatus.openaiConfigured) ||
                Boolean(aiSettings.apiKeys?.[prov]);
              const label =
                prov === 'gemini' ? 'Gemini ★' : prov === 'claude' ? 'Claude' : 'OpenAI';
              return (
                <button
                  key={prov}
                  onClick={() => {
                    const updated = { ...aiSettings, activeProvider: prov };
                    setAiSettings(updated);
                    saveAISettings(updated);
                  }}
                  style={{
                    border: 'none',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                    background: active ? 'var(--accent-blue)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary)',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                  title={
                    envReady
                      ? `${label} — Shared Environment API Key Active`
                      : `${label} — Add API key in .env / Vercel or Settings`
                  }
                >
                  <span
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: envReady ? '#34d399' : '#64748b',
                    }}
                  />
                  {label}
                </button>
              );
            })}
            <button
              className="btn"
              style={{ padding: '4px 7px', border: 'none', background: 'transparent' }}
              onClick={() => setIsAISettingsOpen(true)}
              title="Configure API Keys & Models (Gemini, Claude, OpenAI)"
            >
              <Settings size={14} />
            </button>
          </div>

          <button
            className="btn btn-primary"
            onClick={handleExport}
            disabled={!activeSource || !activeClip || isExporting}
            title="Export the active 9:16 vertical clip as a classic H.264/AAC .mp4 video file"
          >
            <Download size={14} />
            {isExporting ? `Exporting MP4 (${exportProgress}%)...` : 'Export 9:16 MP4'}
          </button>

          {/* Signed-in @complex.com User Badge & Sign Out */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderRadius: 6,
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid #334155',
              fontSize: 11,
              color: '#cbd5e1',
            }}
            title={`Signed in as ${authUser.email}`}
          >
            <span style={{ color: '#34d399', fontWeight: 700 }}>●</span>
            <span style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
                color: '#94a3b8',
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                padding: 2,
              }}
              title="Sign out of @complex.com account"
            >
              <LogOut size={12} />
            </button>
          </div>
        </div>
      </header>

      {/* Main 3-Column Studio Workspace */}
      <main className="studio-workspace">
        {/* LEFT COLUMN: Viral Clips vs Compilation Cutdowns Generator + Clips List */}
        <aside className="studio-panel">
          <div className="studio-panel-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={14} color="#60a5fa" />
              1. Clip &amp; Compilation Generator
            </span>
            <div style={{ display: 'flex', gap: 5 }}>
              <button
                className="btn"
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => handleSaveAndApplyScheme(false)}
                title="Save current settings as a reusable scheme"
              >
                <Save size={11} />
                Save Preset
              </button>
            </div>
          </div>

          {/* Generator Controls */}
          <div
            style={{
              padding: 12,
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {/* Primary Mode Choice: Find Best Viral Clips vs Create Compilation Cutdowns */}
            <div>
              <label
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  display: 'block',
                  marginBottom: 5,
                  fontWeight: 600,
                }}
              >
                What do you want to create?
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <button
                  type="button"
                  onClick={() => handleSelectClipMode('clip-segment')}
                  style={{
                    padding: '8px 9px',
                    borderRadius: 6,
                    border:
                      currentClipMode === 'clip-segment'
                        ? '1.5px solid var(--accent-blue)'
                        : '1px solid var(--border-subtle)',
                    background:
                      currentClipMode === 'clip-segment'
                        ? 'rgba(45, 140, 235, 0.2)'
                        : 'var(--bg-input)',
                    color: '#fff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.12s',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontWeight: 700,
                      fontSize: 11.5,
                      color: currentClipMode === 'clip-segment' ? '#60a5fa' : '#e5e7eb',
                    }}
                  >
                    <Flame size={13} color="#f59e0b" />
                    Best Viral Clips
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Continuous top-scoring viral segments
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => handleSelectClipMode('condensed-edit')}
                  style={{
                    padding: '8px 9px',
                    borderRadius: 6,
                    border:
                      currentClipMode === 'condensed-edit'
                        ? '1.5px solid #8b5cf6'
                        : '1px solid var(--border-subtle)',
                    background:
                      currentClipMode === 'condensed-edit'
                        ? 'rgba(139, 92, 246, 0.22)'
                        : 'var(--bg-input)',
                    color: '#fff',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.12s',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontWeight: 700,
                      fontSize: 11.5,
                      color: currentClipMode === 'condensed-edit' ? '#c4b5fd' : '#e5e7eb',
                    }}
                  >
                    <Layers size={13} color="#a78bfa" />
                    Compilation Cutdown
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginTop: 2 }}>
                    Stitches best highlights into length
                  </div>
                </button>
              </div>
            </div>

            {/* Clip Length (up to 3 mins / 180s with BOTH Text Input + Slider) */}
            <div
              style={{
                background: 'rgba(18, 20, 24, 0.7)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 6,
                padding: '8px 10px',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  marginBottom: 6,
                }}
              >
                <div>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: '#e5e7eb' }}>
                    Target Length (5s – 3m / 180s)
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    Type seconds (e.g. 90) or mm:ss (e.g. 2:30) or drag slider
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input
                    type="text"
                    className="input-field"
                    style={{
                      width: 68,
                      padding: '4px 7px',
                      textAlign: 'center',
                      fontWeight: 700,
                      color: '#60a5fa',
                      fontFamily: 'var(--font-mono)',
                    }}
                    value={durationTextInput}
                    title="Enter clip length in seconds (5–180) or mm:ss (e.g. 1:30, 3:00)"
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
                  <span style={{ fontSize: 10.5, color: 'var(--text-secondary)' }}>sec</span>
                </div>
              </div>

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
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 9.5,
                  color: 'var(--text-muted)',
                  marginTop: 2,
                }}
              >
                <span>5s</span>
                <span>30s</span>
                <span>1m (60s)</span>
                <span>2m (120s)</span>
                <span style={{ color: '#93c5fd', fontWeight: 600 }}>
                  {formatDurationBadge(activeScheme.targetClipDuration)}
                </span>
                <span>3m (180s)</span>
              </div>
            </div>

            {/* How Many Clips + Shot Length (ASL) */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 11,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>How Many Clips</span>
                  <input
                    type="number"
                    min={1}
                    max={12}
                    className="input-field"
                    style={{
                      width: 48,
                      padding: '2px 5px',
                      textAlign: 'center',
                      fontWeight: 700,
                      color: '#34d399',
                    }}
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
                <input
                  type="range"
                  min={1}
                  max={12}
                  step={1}
                  value={activeScheme.maxClipsCount}
                  onChange={(e) => handleChangeClipsCount(parseInt(e.target.value, 10))}
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    fontSize: 11,
                    marginBottom: 4,
                  }}
                >
                  <span style={{ color: 'var(--text-secondary)' }}>Shot Pace (ASL)</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <input
                      type="number"
                      min={0.8}
                      max={15.0}
                      step={0.1}
                      className="input-field"
                      style={{
                        width: 52,
                        padding: '2px 5px',
                        textAlign: 'center',
                        fontWeight: 700,
                        color: '#60a5fa',
                      }}
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
                    <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>s</span>
                  </div>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={10.0}
                  step={0.1}
                  value={Math.min(10, activeScheme.targetAvgShotLength)}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setAslTextInput(String(v));
                    setActiveScheme({
                      ...activeScheme,
                      targetAvgShotLength: v,
                    });
                  }}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            {/* Primary Generate Action Button */}
            <button
              className={currentClipMode === 'condensed-edit' ? 'btn btn-purple' : 'btn btn-primary'}
              style={{
                width: '100%',
                padding: '8px 12px',
                fontWeight: 700,
                fontSize: 12,
                justifyContent: 'center',
              }}
              onClick={() => handleGenerateClipsFromFullVideo(currentClipMode)}
              disabled={!activeSource}
            >
              <Sparkles size={14} />
              {currentClipMode === 'condensed-edit'
                ? `Generate ${activeScheme.maxClipsCount} Compilation Cutdowns (${activeScheme.targetClipDuration}s)`
                : `Find ${activeScheme.maxClipsCount} Best Viral Clips (${activeScheme.targetClipDuration}s)`}
            </button>

            {schemeSavedNotice && (
              <div
                style={{
                  fontSize: 11.5,
                  color: '#34d399',
                  textAlign: 'center',
                  fontWeight: 500,
                }}
              >
                ✓ {schemeSavedNotice}
              </div>
            )}
          </div>

          {/* Source Video & Generated 9:16 Clips List */}
          <div className="studio-panel-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Film size={14} color="#60a5fa" />
              2. Source Video &amp; Ranked Results ({generatedClips.length})
            </span>
            <span style={{ fontSize: 10.5, color: 'var(--text-secondary)', fontWeight: 400 }}>
              {timelineMode === 'full-source'
                ? 'Full Video Active'
                : currentClipMode === 'condensed-edit'
                  ? 'Compilations'
                  : 'Viral Clips'}
            </span>
          </div>

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
            {!activeSource ? (
              <div
                style={{
                  padding: 20,
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                Upload a video to automatically find the top{' '}
                <strong>{activeScheme.maxClipsCount} Viral Clips</strong> or build{' '}
                <strong>Compilation Cutdowns ({activeScheme.targetClipDuration}s each)</strong>.
              </div>
            ) : (
              <>
                {/* Full Uploaded Video Card */}
                <div
                  onClick={selectFullVideoOnTimeline}
                  style={{
                    padding: 10,
                    borderRadius: 6,
                    background:
                      timelineMode === 'full-source'
                        ? 'rgba(16, 185, 129, 0.16)'
                        : 'rgba(30, 41, 59, 0.65)',
                    border:
                      timelineMode === 'full-source'
                        ? '1.5px solid #10b981'
                        : '1px solid #334155',
                    cursor: 'pointer',
                    transition: 'all 0.12s',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: 4,
                      gap: 6,
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        fontWeight: 700,
                        fontSize: 12.5,
                        color: timelineMode === 'full-source' ? '#34d399' : '#f3f4f6',
                      }}
                    >
                      <Video size={14} color="#34d399" />
                      Full Uploaded Video ({(fullVideoClip?.duration ?? activeSource.duration).toFixed(1)}s)
                    </span>
                    <span
                      style={{
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '2px 6px',
                        borderRadius: 4,
                        background:
                          timelineMode === 'full-source'
                            ? '#10b981'
                            : 'rgba(16, 185, 129, 0.18)',
                        color: timelineMode === 'full-source' ? '#052e16' : '#6ee7b7',
                      }}
                    >
                      {timelineMode === 'full-source' ? 'ON TIMELINE' : 'LOAD FULL VIDEO'}
                    </span>
                  </div>
                  <div
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: '#93c5fd',
                      marginBottom: 6,
                    }}
                  >
                    {activeSource.name} • {fullVideoClip?.subCuts.length || 1}{' '}
                    {(fullVideoClip?.subCuts.length || 1) === 1 ? 'cut' : 'cuts'}
                  </div>

                  {/* Direct 1-click actions on the Full Video Card */}
                  <div
                    style={{ display: 'flex', gap: 6, marginTop: 4 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{
                        flex: 1,
                        padding: '5px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                      onClick={() => handleGenerateClipsFromFullVideo('clip-segment')}
                      title="Find the best continuous viral clips from this video"
                    >
                      <Flame size={12} />
                      Best Viral Clips
                    </button>

                    <button
                      type="button"
                      className="btn btn-purple"
                      style={{
                        flex: 1,
                        padding: '5px 8px',
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                      onClick={() => handleGenerateClipsFromFullVideo('condensed-edit')}
                      title="Create multi-shot compilation cutdowns from this video"
                    >
                      <Layers size={12} />
                      Compilation Cutdown
                    </button>
                  </div>
                </div>

                {/* Divider Label */}
                <div
                  style={{
                    fontSize: 10.5,
                    fontWeight: 600,
                    color: 'var(--text-secondary)',
                    letterSpacing: '0.4px',
                    textTransform: 'uppercase',
                    marginTop: 4,
                    paddingLeft: 2,
                  }}
                >
                  Ranked Clips &amp; Compilations ({generatedClips.length})
                </div>

                {generatedClips.length === 0 ? (
                  <div
                    style={{
                      padding: '16px 12px',
                      borderRadius: 6,
                      border: '1px dashed var(--border-subtle)',
                      background: 'rgba(18, 20, 24, 0.5)',
                      textAlign: 'center',
                      fontSize: 11.5,
                      color: 'var(--text-secondary)',
                      lineHeight: 1.5,
                    }}
                  >
                    No clips generated yet. Your full uploaded video is on the timeline — configure your settings above and click{' '}
                    <strong style={{ color: '#93c5fd' }}>Find Best Viral Clips</strong> or{' '}
                    <strong style={{ color: '#c4b5fd' }}>Compilation Cutdown</strong> when ready.
                  </div>
                ) : (
                  /* Generated & Manually Clipped 9:16 Clips */
                  generatedClips.map((clip) => {
                  const selected =
                    timelineMode === 'elected-clip' && clip.id === selectedClipObj?.id;
                  const isEditMode = clip.clipCreationMode === 'condensed-edit';
                  const isManual = clip.id.startsWith('manual-clip-');
                  return (
                    <div
                      key={clip.id}
                      onClick={() => selectClip(clip)}
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        background: selected ? 'rgba(45, 140, 235, 0.16)' : 'var(--bg-card)',
                        border: selected
                          ? '1.5px solid var(--accent-blue)'
                          : '1px solid var(--border-subtle)',
                        cursor: 'pointer',
                        transition: 'all 0.12s',
                      }}
                    >
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: 4,
                          gap: 6,
                        }}
                      >
                        <span style={{ fontWeight: 600, fontSize: 12 }}>
                          {clip.name}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                          <span
                            style={{
                              fontSize: 9.5,
                              fontWeight: 700,
                              padding: '1px 5px',
                              borderRadius: 3,
                              background: isManual
                                ? 'rgba(245, 158, 11, 0.22)'
                                : isEditMode
                                  ? 'rgba(139, 92, 246, 0.22)'
                                  : 'rgba(45, 140, 235, 0.2)',
                              color: isManual
                                ? '#fcd34d'
                                : isEditMode
                                  ? '#c4b5fd'
                                  : '#93c5fd',
                            }}
                          >
                            {isManual ? 'CUSTOM' : isEditMode ? 'COMPILATION' : 'VIRAL CLIP'}
                          </span>
                          <span
                            style={{
                              fontSize: 10.5,
                              fontWeight: 700,
                              padding: '1px 6px',
                              borderRadius: 4,
                              background: 'rgba(16, 185, 129, 0.18)',
                              color: '#34d399',
                            }}
                          >
                            {clip.viralScore}%
                          </span>
                        </div>
                      </div>
                      <div
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          color: '#93c5fd',
                          marginBottom: 3,
                        }}
                      >
                        {isEditMode
                          ? `${clip.subCuts.length} stitched shots • ${clip.duration.toFixed(1)}s total`
                          : `Source ${formatSMPTETimecode(clip.sourceStart).slice(3, 8)} → ${formatSMPTETimecode(clip.sourceEnd).slice(3, 8)} • ${clip.duration.toFixed(1)}s`}
                      </div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                        {clip.hookReason}
                      </div>
                    </div>
                  );
                })
                )}
              </>
            )}
          </div>
        </aside>

        {/* CENTER STAGE: Native Source Video + 9:16 Output Preview + Subject Focus Bar + Timeline */}
        <section className="studio-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="studio-panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>
                {activeSource
                  ? timelineMode === 'full-source'
                    ? `Timeline: Full Uploaded Video — ${activeSource.name} (${(activeClip?.duration ?? activeSource.duration).toFixed(1)}s)`
                    : activeClip
                      ? `Timeline: ${activeClip.name}`
                      : `Source: ${activeSource.name}`
                  : 'Video Preview & 9:16 Subject Focus'}
              </span>
              {activeSource && timelineMode !== 'full-source' && (
                <button
                  className="btn"
                  style={{
                    padding: '3px 9px',
                    fontSize: 11,
                    borderColor: 'rgba(16, 185, 129, 0.45)',
                    color: '#6ee7b7',
                    background: 'rgba(16, 185, 129, 0.12)',
                  }}
                  onClick={selectFullVideoOnTimeline}
                  title="Put the whole uploaded video onto the timeline by itself"
                >
                  <Video size={12} />
                  Load Full Video on Timeline
                </button>
              )}
            </div>

            {activeSource && activeClip && (
              <span className="timecode-pill">
                {timelineMode === 'full-source' ? 'Full Video ' : 'Clip '}
                {formatSMPTETimecode(clipPlayheadTime)} /{' '}
                {formatSMPTETimecode(activeClip.duration)}
              </span>
            )}
          </div>

          {/* Center Viewport */}
          {!activeSource ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 32,
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
                  maxWidth: 560,
                  padding: '48px 32px',
                  borderRadius: 12,
                  border: '2px dashed #3b4252',
                  background: 'rgba(32, 35, 42, 0.5)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  textAlign: 'center',
                  gap: 14,
                  cursor: 'pointer',
                }}
              >
                <div
                  style={{
                    width: 56,
                    height: 56,
                    borderRadius: '50%',
                    background: 'rgba(45, 140, 235, 0.15)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Upload size={26} color="#60a5fa" />
                </div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>
                  Upload a Video to Find Viral Clips &amp; Build Compilation Cutdowns
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    maxWidth: 460,
                    lineHeight: 1.5,
                  }}
                >
                  Drag and drop any <strong>.mp4</strong>, <strong>.mov</strong>, or{' '}
                  <strong>.webm</strong> video here. Automatically extract top viral segments,
                  stitch multi-cut compilations up to 3 minutes, and click any subject to keep them
                  locked in the center of the 9:16 frame.
                </div>
                <button className="btn btn-primary" style={{ marginTop: 6, padding: '9px 20px' }}>
                  <Upload size={15} />
                  Select Video File
                </button>
              </div>
            </div>
          ) : (
            <>
              {/* Side-by-Side Native Source Video + Live 9:16 Cropped Output */}
              <div
                style={{
                  flex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 24,
                  padding: '14px 18px',
                  minHeight: 0,
                  background: '#0d0e11',
                  overflow: 'hidden',
                }}
              >
                {/* LEFT VIEWER: True Native Aspect Ratio Source Video + Interactive 9:16 Subject Focus Picker */}
                <div
                  style={{
                    flex: 1.35,
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minWidth: 0,
                    minHeight: 0,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: '#93c5fd',
                      marginBottom: 6,
                      fontWeight: 600,
                      letterSpacing: '0.2px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <Crosshair size={13} color="#34d399" />
                    CLICK ANY OBJECT ON VIDEO TO LOCK &amp; TRACK IN 9:16 ({nativeDims.width}×{nativeDims.height})
                    {isSolvingObjectTrack && (
                      <span
                        style={{
                          marginLeft: 8,
                          padding: '1px 7px',
                          borderRadius: 4,
                          background: 'rgba(16, 185, 129, 0.22)',
                          border: '1px solid #10b981',
                          color: '#6ee7b7',
                          fontSize: 10.5,
                        }}
                      >
                        Solving Object Path {objectTrackProgress}%...
                      </span>
                    )}
                    {!isSolvingObjectTrack &&
                      activeClip?.subjectFocus?.trackedPath &&
                      activeClip.subjectFocus.trackedPath.length > 1 && (
                        <span
                          style={{
                            marginLeft: 8,
                            padding: '1px 7px',
                            borderRadius: 4,
                            background: 'rgba(16, 185, 129, 0.18)',
                            color: '#34d399',
                            fontSize: 10.5,
                          }}
                        >
                          ✓ Tracked ({activeClip.subjectFocus.trackedPath.length} frames)
                        </span>
                      )}
                  </div>

                  <div
                    ref={sourceOverlayWrapRef}
                    style={{
                      position: 'relative',
                      aspectRatio: `${nativeDims.width} / ${nativeDims.height}`,
                      maxWidth: '100%',
                      maxHeight: 'calc(100% - 26px)',
                      background: '#000',
                      borderRadius: 6,
                      overflow: 'hidden',
                      boxShadow: '0 8px 28px rgba(0,0,0,0.65)',
                      border: '1px solid #2b303c',
                      cursor: 'crosshair',
                    }}
                    onMouseDown={(e) => {
                      setIsDraggingCrop(true);
                      handlePointerOnSourceVideo(e, false);
                    }}
                    onMouseMove={(e) => {
                      if (isDraggingCrop) handlePointerOnSourceVideo(e, false);
                    }}
                    onMouseUp={(e) => {
                      if (isDraggingCrop) {
                        setIsDraggingCrop(false);
                        handlePointerOnSourceVideo(e, true);
                      }
                    }}
                    onMouseLeave={() => setIsDraggingCrop(false)}
                    title="Click any object (car, person, prop) to lock onto it and track its trajectory across the video"
                  >
                    {/* Real Native <video> Element */}
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

                    {/* Smooth Multi-Point Focus Lock Curve & Numbered Lock Badges (when 2+ user lock points exist) */}
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
                          stroke="rgba(16, 185, 129, 0.72)"
                          strokeWidth="0.65"
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
                              width: isNearNow ? 20 : 16,
                              height: isNearNow ? 20 : 16,
                              borderRadius: '50%',
                              background: isNearNow ? '#10b981' : 'rgba(15, 23, 42, 0.88)',
                              border: isNearNow ? '2px solid #fef08a' : '1.5px solid #34d399',
                              color: isNearNow ? '#052e16' : '#6ee7b7',
                              fontSize: 9,
                              fontWeight: 800,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              boxShadow: '0 2px 6px rgba(0,0,0,0.65)',
                              pointerEvents: 'none',
                              zIndex: 4,
                            }}
                          >
                            {idx + 1}
                          </div>
                        );
                      })}

                    {/* Tight Target Object Bounding Box (shows exact lock on the car/object itself) */}
                    {activeFocusStrategy === 'click-track' && (
                      <div
                        style={{
                          position: 'absolute',
                          left: `${Math.max(0, (currentTrack.rawX - (currentTrack.objectBoxW ?? 0.14) / 2) * 100)}%`,
                          top: `${Math.max(0, (currentTrack.rawY - (currentTrack.objectBoxH ?? 0.16) / 2) * 100)}%`,
                          width: `${(currentTrack.objectBoxW ?? 0.14) * 100}%`,
                          height: `${(currentTrack.objectBoxH ?? 0.16) * 100}%`,
                          border: '1.5px dashed #34d399',
                          background: 'rgba(16, 185, 129, 0.08)',
                          borderRadius: 4,
                          pointerEvents: 'none',
                          zIndex: 3,
                        }}
                      >
                        <span
                          style={{
                            position: 'absolute',
                            bottom: '100%',
                            left: 0,
                            background: 'rgba(5, 150, 105, 0.9)',
                            color: '#fff',
                            fontSize: 8.5,
                            fontWeight: 700,
                            padding: '1px 4px',
                            borderRadius: 2,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {userFocusAnchors.length >= 2
                            ? `OBJECT LOCK • SMOOTH BLEND (${userFocusAnchors.length} PTS)`
                            : 'OBJECT LOCK'}
                        </span>
                      </div>
                    )}

                    {/* Interactive 9:16 Subject Tracking Crop Box Overlay */}
                    <div
                      style={{
                        position: 'absolute',
                        left: `${currentCrop.normX * 100}%`,
                        top: `${currentCrop.normY * 100}%`,
                        width: `${currentCrop.normW * 100}%`,
                        height: `${currentCrop.normH * 100}%`,
                        border:
                          activeFocusStrategy === 'click-track' ||
                          activeFocusStrategy === 'static-lock'
                            ? '2px solid #10b981'
                            : '2px solid #2d8ceb',
                        boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.52)',
                        pointerEvents: 'none',
                      }}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          top: 4,
                          left: 4,
                          background:
                            activeFocusStrategy === 'click-track' ||
                            activeFocusStrategy === 'static-lock'
                              ? '#059669'
                              : '#2d8ceb',
                          color: '#fff',
                          fontSize: 9.5,
                          fontWeight: 700,
                          padding: '2px 6px',
                          borderRadius: 3,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {currentTrack.subjectLabel} • {currentZoom.toFixed(2)}x
                      </div>

                      {/* Locked Subject Target Reticle in the exact center of the 9:16 crop */}
                      <div
                        style={{
                          position: 'absolute',
                          left: '50%',
                          top: '50%',
                          width: 22,
                          height: 22,
                          transform: 'translate(-50%, -50%)',
                          border: '2px solid #34d399',
                          borderRadius: '50%',
                          boxShadow: '0 0 8px rgba(16, 185, 129, 0.8)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <div
                          style={{
                            width: 4,
                            height: 4,
                            borderRadius: '50%',
                            background: '#34d399',
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* RIGHT VIEWER: Live 9:16 Vertical Social Output (Distortion-Free) */}
                <div
                  style={{
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      fontSize: 11,
                      color: '#34d399',
                      marginBottom: 6,
                      fontWeight: 600,
                      letterSpacing: '0.3px',
                    }}
                  >
                    9:16 CENTERED SUBJECT OUTPUT
                  </div>

                  <canvas
                    ref={preview9x16CanvasRef}
                    width={540}
                    height={960}
                    style={{
                      height: 'calc(100% - 26px)',
                      width: 'auto',
                      aspectRatio: '9 / 16',
                      background: '#000',
                      borderRadius: 8,
                      border: '2px solid #10b981',
                      boxShadow: '0 10px 30px rgba(0,0,0,0.75)',
                    }}
                  />
                </div>
              </div>

              {/* DEDICATED 9:16 SUBJECT FOCUS BAR — Pick Subject Focus so it stays in the center of 9:16 */}
              <div
                style={{
                  padding: '8px 16px',
                  background: 'rgba(15, 23, 42, 0.92)',
                  borderTop: '1px solid #1e293b',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: '#34d399',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      marginRight: 4,
                    }}
                  >
                    <Crosshair size={13} />
                    9:16 Subject Focus:
                  </span>

                  {/* Click Mode Toggle: Track Clicked Subject vs Lock Static Position */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setClickPickMode('track');
                      if (activeClip?.subjectFocus) {
                        applySubjectFocusConfig({
                          ...activeClip.subjectFocus,
                          strategy: 'click-track',
                          label: 'Tracked Subject Focus',
                        });
                      }
                    }}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                      borderColor:
                        clickPickMode === 'track' &&
                        (activeFocusStrategy === 'click-track' ||
                          activeFocusStrategy === 'auto-salient')
                          ? '#10b981'
                          : 'var(--border-subtle)',
                      background:
                        activeFocusStrategy === 'click-track'
                          ? 'rgba(16, 185, 129, 0.22)'
                          : 'var(--bg-card)',
                      color: activeFocusStrategy === 'click-track' ? '#6ee7b7' : '#e2e8f0',
                      fontWeight: activeFocusStrategy === 'click-track' ? 700 : 500,
                    }}
                    title="Click any subject on the 16:9 video and actively follow its movement to keep it centered in 9:16"
                  >
                    <Crosshair size={12} />
                    🎯 Click Video to Track Subject
                  </button>

                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setClickPickMode('static');
                      if (activeClip?.subjectFocus) {
                        applySubjectFocusConfig({
                          ...activeClip.subjectFocus,
                          strategy: 'static-lock',
                          label: 'Pinned Position Lock',
                        });
                      }
                    }}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                      borderColor:
                        activeFocusStrategy === 'static-lock'
                          ? '#f59e0b'
                          : 'var(--border-subtle)',
                      background:
                        activeFocusStrategy === 'static-lock'
                          ? 'rgba(245, 158, 11, 0.2)'
                          : 'var(--bg-card)',
                      color: activeFocusStrategy === 'static-lock' ? '#fcd34d' : '#e2e8f0',
                      fontWeight: activeFocusStrategy === 'static-lock' ? 700 : 500,
                    }}
                    title="Click any spot on the 16:9 video to lock the 9:16 crop at that exact horizontal position"
                  >
                    <Lock size={12} />
                    📌 Lock Static Position
                  </button>

                  {/* 1-Click Subject Focus Presets */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleSelectSubjectFocusStrategy('face-speaker')}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                      borderColor:
                        activeFocusStrategy === 'face-speaker'
                          ? '#60a5fa'
                          : 'var(--border-subtle)',
                      background:
                        activeFocusStrategy === 'face-speaker'
                          ? 'rgba(45, 140, 235, 0.22)'
                          : 'var(--bg-card)',
                    }}
                    title="Automatically keep the primary face/speaker centered in 9:16"
                  >
                    <UserCheck size={12} />
                    Auto Face/Speaker
                  </button>

                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleSelectSubjectFocusStrategy('left-subject')}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                      borderColor:
                        activeFocusStrategy === 'left-subject'
                          ? '#60a5fa'
                          : 'var(--border-subtle)',
                      background:
                        activeFocusStrategy === 'left-subject'
                          ? 'rgba(45, 140, 235, 0.22)'
                          : 'var(--bg-card)',
                    }}
                    title="Focus and track the subject on the left side of the 16:9 frame"
                  >
                    ⬅ Left Subject
                  </button>

                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleSelectSubjectFocusStrategy('static-lock')}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                    }}
                    title="Lock the 9:16 crop in the dead-center (50%) of the 16:9 frame"
                  >
                    ⏺ Center
                  </button>

                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleSelectSubjectFocusStrategy('right-subject')}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                      borderColor:
                        activeFocusStrategy === 'right-subject'
                          ? '#60a5fa'
                          : 'var(--border-subtle)',
                      background:
                        activeFocusStrategy === 'right-subject'
                          ? 'rgba(45, 140, 235, 0.22)'
                          : 'var(--bg-card)',
                    }}
                    title="Focus and track the subject on the right side of the 16:9 frame"
                  >
                    ➡ Right Subject
                  </button>

                  <button
                    type="button"
                    className="btn"
                    onClick={() => handleSelectSubjectFocusStrategy('action-motion')}
                    style={{
                      padding: '4px 9px',
                      fontSize: 11,
                      borderColor:
                        activeFocusStrategy === 'action-motion'
                          ? '#60a5fa'
                          : 'var(--border-subtle)',
                      background:
                        activeFocusStrategy === 'action-motion'
                          ? 'rgba(45, 140, 235, 0.22)'
                          : 'var(--bg-card)',
                    }}
                    title="Follow the highest-motion action cluster in the frame"
                  >
                    <Zap size={12} />
                    Action Motion
                  </button>

                  {userFocusAnchors.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        flexWrap: 'wrap',
                        background: 'rgba(6, 78, 59, 0.28)',
                        border: '1px solid rgba(16, 185, 129, 0.35)',
                        borderRadius: 6,
                        padding: '2px 6px',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 700,
                          color: '#6ee7b7',
                        }}
                        title="Click on the 16:9 video at any point along the timeline to add another Focus Lock Point — ClipMaker smoothly blends between all lock points!"
                      >
                        Focus Locks ({userFocusAnchors.length}):
                      </span>

                      {userFocusAnchors.map((pt, idx) => {
                        const isNearCurrent = Math.abs(pt.time - playheadTime) < 0.35;
                        return (
                          <div
                            key={`focus-pill-${pt.time}-${idx}`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 6px',
                              borderRadius: 4,
                              fontSize: 10.5,
                              fontFamily: 'var(--font-mono)',
                              background: isNearCurrent
                                ? 'rgba(16, 185, 129, 0.35)'
                                : 'rgba(15, 23, 42, 0.85)',
                              border: isNearCurrent
                                ? '1px solid #34d399'
                                : '1px solid rgba(148, 163, 184, 0.3)',
                              color: isNearCurrent ? '#ecfdf5' : '#cbd5e1',
                            }}
                          >
                            <span
                              onClick={() => handleSeekSourceTime(pt.time)}
                              style={{ cursor: 'pointer', fontWeight: 600 }}
                              title={`Jump playhead to Focus Lock #${idx + 1} at ${pt.time.toFixed(2)}s`}
                            >
                              ◆ #{idx + 1} ({pt.time.toFixed(1)}s)
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteFocusLockPoint(pt.time);
                              }}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: '#fca5a5',
                                cursor: 'pointer',
                                fontSize: 11,
                                fontWeight: 700,
                                padding: '0 2px',
                                lineHeight: 1,
                              }}
                              title={`Remove Focus Lock #${idx + 1} (${pt.time.toFixed(1)}s)`}
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}

                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          const curT = videoRef.current?.currentTime ?? playheadTime;
                          const nextT = Math.min(
                            activeSource?.duration ?? curT + 2,
                            Number((curT + 2.0).toFixed(2))
                          );
                          handleSeekSourceTime(nextT);
                          setMarkerNotice(
                            `⏩ Stepped to ${nextT.toFixed(1)}s — now click the object on the video to add Focus Lock #${userFocusAnchors.length + 1}!`
                          );
                          setTimeout(() => setMarkerNotice(null), 3200);
                        }}
                        style={{
                          padding: '2px 7px',
                          fontSize: 10.5,
                          borderColor: 'rgba(52, 211, 153, 0.5)',
                          background: 'rgba(16, 185, 129, 0.2)',
                          color: '#a7f3d0',
                          fontWeight: 600,
                        }}
                        title="Step forward 2 seconds on the timeline so you can click the object on the video to add your next Focus Lock Point"
                      >
                        ⏩ +2s (Add Next Lock)
                      </button>

                      <button
                        type="button"
                        className="btn"
                        onClick={() => {
                          userFocusAnchorsRef.current = [];
                          liveTrackedAnchorRef.current = null;
                          handleSelectSubjectFocusStrategy('auto-salient');
                        }}
                        style={{
                          padding: '2px 7px',
                          fontSize: 10.5,
                          borderColor: 'rgba(248, 113, 113, 0.45)',
                          background: 'rgba(239, 68, 68, 0.14)',
                          color: '#fca5a5',
                        }}
                        title="Clear all Focus Lock Points and reset to auto subject focus"
                      >
                        <RotateCcw size={10} />
                        Clear All
                      </button>
                    </div>
                  )}
                </div>

                {/* Right: Zoom Control + Fine Horizontal Trim Slider + Apply to All Clips Toggle */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>Zoom:</span>
                    <input
                      type="range"
                      min={0.56}
                      max={1.5}
                      step={0.02}
                      value={currentZoom}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        applyZoomAcrossStudio(v, applyFocusToAllClips);
                      }}
                      style={{ width: 72 }}
                      title="Adjust 9:16 zoom across timeline cuts (1.00x = 100% full height, <1.00x = wide letterbox, >1.00x = punch-in)"
                    />
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10.5,
                        color: currentZoom === 1.0 ? '#6ee7b7' : '#e2e8f0',
                        minWidth: 36,
                      }}
                    >
                      {currentZoom.toFixed(2)}x
                    </span>
                    <button
                      className="btn-secondary"
                      onClick={() => applyZoomAcrossStudio(1.0, true)}
                      style={{
                        padding: '2px 6px',
                        fontSize: 10,
                        background:
                          Math.abs(currentZoom - 1.0) < 0.015
                            ? 'rgba(16, 185, 129, 0.2)'
                            : undefined,
                        borderColor:
                          Math.abs(currentZoom - 1.0) < 0.015
                            ? 'rgba(16, 185, 129, 0.5)'
                            : undefined,
                        color: Math.abs(currentZoom - 1.0) < 0.015 ? '#6ee7b7' : undefined,
                      }}
                      title="Remove all punch-in zoom (set every cut across the timeline to 1.00x / 100% height)"
                    >
                      1.0x No Zoom
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => applyZoomAcrossStudio(0.56, true)}
                      style={{
                        padding: '2px 6px',
                        fontSize: 10,
                        background:
                          currentZoom <= 0.6 ? 'rgba(56, 189, 248, 0.2)' : undefined,
                        borderColor:
                          currentZoom <= 0.6 ? 'rgba(56, 189, 248, 0.5)' : undefined,
                        color: currentZoom <= 0.6 ? '#7dd3fc' : undefined,
                      }}
                      title="Fit the entire 16:9 horizontal width inside the 9:16 frame (0.56x letterbox)"
                    >
                      Fit 16:9
                    </button>
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 11,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>Fine X Offset:</span>
                    <input
                      type="range"
                      min={-0.3}
                      max={0.3}
                      step={0.01}
                      value={activeClip?.trackingOffsetX ?? 0}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value);
                        updateActiveTimelineClip((c) => ({ ...c, trackingOffsetX: v }));
                      }}
                      style={{ width: 70 }}
                      title="Fine-tune the horizontal center of the 9:16 frame"
                    />
                  </div>

                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 5,
                      fontSize: 11,
                      color: '#cbd5e1',
                      cursor: 'pointer',
                    }}
                    title="When checked, picking a subject focus or zoom applies to all generated clips from this video"
                  >
                    <input
                      type="checkbox"
                      checked={applyFocusToAllClips}
                      onChange={(e) => setApplyFocusToAllClips(e.target.checked)}
                    />
                    Apply Focus to All Clips
                  </label>
                </div>
              </div>

              {/* AI VIDEO EDITOR SKILLS & TOOLS BAR (Auto-Editor Silence Stripper, 2-Speaker Split-Screen, Blurred 9:16 Fill, Word Karaoke Captions, Beat-Sync, Speed Ramps) */}
              <div
                style={{
                  padding: '7px 14px',
                  background: 'rgba(15, 23, 42, 0.88)',
                  borderTop: '1px solid var(--border-subtle)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 800,
                      color: '#34d399',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      marginRight: 2,
                      letterSpacing: '0.2px',
                    }}
                  >
                    <Wand2 size={12} color="#34d399" />
                    AI EDIT SKILLS:
                  </span>

                  {/* 1. Auto-Silence & Dead-Air Jump Cutter */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!activeClip || !activeSource) return;
                      updateActiveTimelineClip((clip) => {
                        const res = stripSilenceFromClip(clip, activeSource, 0.18);
                        setMarkerNotice(
                          `✂ Auto-Silence Cutter: Stripped ${res.removedSeconds.toFixed(1)}s of dead air across ${res.cutsCreated} speech cuts!`
                        );
                        setTimeout(() => setMarkerNotice(null), 3200);
                        return res.updatedClip;
                      });
                    }}
                    style={{
                      padding: '3px 8px',
                      fontSize: 10.5,
                      background: 'rgba(16, 185, 129, 0.14)',
                      borderColor: 'rgba(16, 185, 129, 0.42)',
                      color: '#6ee7b7',
                      fontWeight: 700,
                    }}
                    title="Auto-Editor Jump Cutter: Scans audio RMS waveform and ripple-cuts silent pauses & dead air out of the timeline"
                  >
                    ✂ Strip Dead Air
                  </button>

                  {/* 2. Beat-Sync & Audio Peak Auto-Cutter */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!activeClip || !activeSource) return;
                      updateActiveTimelineClip((clip) => {
                        const res = snapCutsToAudioBeats(clip, activeSource);
                        setMarkerNotice(
                          `🎵 Beat-Sync Cutter: Created ${res.beatCutsCount} audio-peak synced cuts!`
                        );
                        setTimeout(() => setMarkerNotice(null), 3000);
                        return res.updatedClip;
                      });
                    }}
                    style={{
                      padding: '3px 8px',
                      fontSize: 10.5,
                    }}
                    title="Slice and align timeline cuts to detected audio transients & beats"
                  >
                    🎵 Beat-Sync Cuts
                  </button>

                  {/* 3. Word-Level Karaoke Captions (Real Gemini 4 Argon Audio Transcription) */}
                  <button
                    type="button"
                    className="btn"
                    disabled={isTranscribingAudio}
                    onClick={handleRunAITranscription}
                    style={{
                      padding: '3px 8px',
                      fontSize: 10.5,
                      background: isTranscribingAudio
                        ? 'rgba(59, 130, 246, 0.25)'
                        : (activeClip?.captions?.[0]?.words?.length ?? 0) > 0
                          ? 'rgba(250, 204, 21, 0.16)'
                          : undefined,
                      borderColor: isTranscribingAudio
                        ? '#60a5fa'
                        : (activeClip?.captions?.[0]?.words?.length ?? 0) > 0
                          ? 'rgba(250, 204, 21, 0.48)'
                          : undefined,
                      color: isTranscribingAudio
                        ? '#93c5fd'
                        : (activeClip?.captions?.[0]?.words?.length ?? 0) > 0
                          ? '#fde047'
                          : undefined,
                    }}
                    title="Extracts real audio from your timeline and transcribes verbatim word-by-word karaoke captions with Gemini 4 Argon"
                  >
                    {isTranscribingAudio
                      ? '🎙️ Transcribing Audio...'
                      : '🎤 AI Transcribe Karaoke Captions'}
                  </button>

                  {/* 4. 2-Speaker Top/Bottom Podcast Split-Screen */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!activeClip || !activeSource) return;
                      updateActiveTimelineClip((clip) => {
                        const nextMode: BackgroundFillStyle =
                          clip.backgroundFillStyle === 'split-screen' ? 'blurred' : 'split-screen';
                        setMarkerNotice(
                          nextMode === 'split-screen'
                            ? '👥 Enabled 9:16 Top/Bottom Dual-Speaker Podcast Split-Screen!'
                            : 'Switched back to Single-Frame 9:16 view'
                        );
                        setTimeout(() => setMarkerNotice(null), 2800);
                        return applyTwoSpeakerEditMode(clip, activeSource, nextMode);
                      });
                    }}
                    style={{
                      padding: '3px 8px',
                      fontSize: 10.5,
                      background:
                        activeClip?.backgroundFillStyle === 'split-screen'
                          ? 'rgba(59, 130, 246, 0.24)'
                          : undefined,
                      borderColor:
                        activeClip?.backgroundFillStyle === 'split-screen'
                          ? '#60a5fa'
                          : undefined,
                      color:
                        activeClip?.backgroundFillStyle === 'split-screen'
                          ? '#93c5fd'
                          : undefined,
                    }}
                    title="Stack Left Speaker (top half) and Right Speaker (bottom half) in a 9:16 podcast split-screen"
                  >
                    👥 2-Speaker Split-Screen
                  </button>

                  {/* 5. 2-Speaker Active Camera Auto-Switcher */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      if (!activeClip || !activeSource) return;
                      updateActiveTimelineClip((clip) => {
                        const next = applyTwoSpeakerEditMode(clip, activeSource, 'auto-switch');
                        setMarkerNotice(
                          `🔀 Applied 2-Speaker Auto Camera Switch across ${next.subCuts.length} cuts!`
                        );
                        setTimeout(() => setMarkerNotice(null), 2800);
                        return next;
                      });
                    }}
                    style={{
                      padding: '3px 8px',
                      fontSize: 10.5,
                    }}
                    title="Automatically alternate camera focus between Left Speaker and Right Speaker across timeline cuts"
                  >
                    🔀 Auto-Switch Speakers
                  </button>
                </div>

                {/* Right side of AI Skills Bar: Blurred 9:16 Fill Toggle + Playback Speed Ramp */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10.5,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>9:16 Fill:</span>
                    {(
                      [
                        { id: 'blurred', label: '🌫 Blur Fill' },
                        { id: 'black', label: '⬛ Black Bars' },
                      ] as Array<{ id: BackgroundFillStyle; label: string }>
                    ).map((opt) => {
                      const activeFill = activeClip?.backgroundFillStyle ?? 'blurred';
                      const isSel = activeFill === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          className="btn"
                          onClick={() =>
                            updateActiveTimelineClip((c) => ({
                              ...c,
                              backgroundFillStyle: opt.id,
                            }))
                          }
                          style={{
                            padding: '2px 7px',
                            fontSize: 10,
                            background: isSel ? 'rgba(45, 140, 235, 0.22)' : undefined,
                            borderColor: isSel ? '#60a5fa' : undefined,
                            color: isSel ? '#93c5fd' : undefined,
                          }}
                          title="Choose whether zoomed-out (<1.0x) frames use a soft Gaussian-blurred 9:16 background or black letterbox bars"
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 10.5,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>Speed:</span>
                    {[0.75, 1.0, 1.25, 1.5].map((spd) => {
                      const curSpd = activeClip?.playbackSpeed ?? 1.0;
                      const isSel = Math.abs(curSpd - spd) < 0.03;
                      return (
                        <button
                          key={spd}
                          type="button"
                          className="btn"
                          onClick={() => {
                            if (videoRef.current) {
                              videoRef.current.playbackRate = spd;
                            }
                            updateActiveTimelineClip((c) => ({
                              ...c,
                              playbackSpeed: spd,
                              subCuts: c.subCuts.map((cut) => ({ ...cut, speed: spd })),
                            }));
                          }}
                          style={{
                            padding: '2px 6px',
                            fontSize: 10,
                            fontFamily: 'var(--font-mono)',
                            background: isSel ? 'rgba(16, 185, 129, 0.22)' : undefined,
                            borderColor: isSel ? '#34d399' : undefined,
                            color: isSel ? '#6ee7b7' : undefined,
                          }}
                          title={`Set playback speed to ${spd}x`}
                        >
                          {spd}x
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </>
          )}

          {/* TIMELINE, RAZOR BLADE TOOL & IN/OUT MARKER CLIPPING BAR */}
          {activeSource && activeClip && (
            <div
              style={{
                padding: '12px 16px',
                background: 'var(--bg-panel-header)',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 9,
              }}
            >
              {/* Row 1: Transport + Razor Blade Tool + In/Out Marker Controls */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: 8,
                }}
              >
                {/* Left Transport + Razor Blade Tool Buttons */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleTogglePlay(false)}
                  >
                    {isPlaying && !isLoopingInOut ? <Pause size={14} /> : <Play size={14} />}
                    {isPlaying && !isLoopingInOut
                      ? 'Pause'
                      : timelineMode === 'full-source'
                        ? 'Play Full Video'
                        : 'Play Clip'}
                  </button>

                  <button
                    className="btn"
                    onClick={() => {
                      const nextMute = !isMuted;
                      setIsMuted(nextMute);
                      if (videoRef.current) videoRef.current.muted = nextMute;
                    }}
                    title="Mute / Unmute Audio"
                  >
                    {isMuted ? <VolumeX size={14} color="#f87171" /> : <Volume2 size={14} />}
                  </button>

                  {/* RAZOR BLADE TOOL TOGGLE (Shortcut: C) */}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setIsRazorMode((prev) => !prev)}
                    style={{
                      borderColor: isRazorMode ? '#ef4444' : 'var(--border-subtle)',
                      background: isRazorMode ? 'rgba(239, 68, 68, 0.22)' : 'var(--bg-card)',
                      color: isRazorMode ? '#fca5a5' : 'var(--text-main)',
                      fontWeight: isRazorMode ? 700 : 500,
                    }}
                    title="Toggle Razor Blade Tool (Shortcut: C) — Click anywhere on the timeline to slice"
                  >
                    <Scissors size={14} color={isRazorMode ? '#f87171' : '#60a5fa'} />
                    {isRazorMode ? 'Razor Blade ON (Click Timeline)' : 'Razor Blade Tool (C)'}
                  </button>

                  <button
                    type="button"
                    className="btn"
                    onClick={handleSplitAtPlayhead}
                    title="Immediately slice the timeline at the current playhead position"
                  >
                    <Scissors size={13} />
                    Cut at Playhead
                  </button>

                  {activeClip.subCuts.length > 1 && inspectedCut && (
                    <>
                      <button
                        type="button"
                        className="btn"
                        style={{
                          borderColor: 'rgba(239, 68, 68, 0.45)',
                          color: '#fca5a5',
                          padding: '6px 9px',
                          fontSize: 11.5,
                        }}
                        onClick={handleDeleteSelectedCut}
                        title={`Delete Cut #${inspectedCut.index} from timeline (Shortcut: Delete / Backspace)`}
                      >
                        <Trash2 size={13} />
                        Delete Cut #{inspectedCut.index}
                      </button>

                      <button
                        type="button"
                        className="btn"
                        style={{
                          borderColor: 'rgba(96, 165, 250, 0.45)',
                          color: '#93c5fd',
                          padding: '6px 9px',
                          fontSize: 11.5,
                        }}
                        onClick={handleSaveSelectedCutAsClip}
                        title={`Save Cut #${inspectedCut.index} as its own standalone 9:16 clip in the Clips list`}
                      >
                        <Plus size={13} />
                        Save Cut #{inspectedCut.index} as Clip
                      </button>
                    </>
                  )}

                  {timelineMode === 'full-source' && activeClip.subCuts.length > 1 && (
                    <button
                      type="button"
                      className="btn"
                      style={{ padding: '6px 9px', fontSize: 11 }}
                      onClick={() =>
                        setFullVideoClip(createInitialFullVideoClip(activeSource, activeScheme))
                      }
                      title="Reset all razor cuts on the Full Uploaded Video"
                    >
                      <RotateCcw size={12} />
                      Reset Full Video
                    </button>
                  )}
                </div>

                {/* Right: IN [I] & OUT [O] Marker Controls + Create Clip / Compilation from In→Out */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    background: 'rgba(17, 19, 24, 0.9)',
                    border: '1px solid #334155',
                    borderRadius: 6,
                    padding: '4px 8px',
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    className="btn"
                    style={{
                      padding: '4px 9px',
                      fontSize: 11.5,
                      borderColor: '#10b981',
                      background: 'rgba(16, 185, 129, 0.16)',
                      color: '#6ee7b7',
                      fontWeight: 600,
                    }}
                    onClick={handleSetInMarkerAtPlayhead}
                    title="Set IN marker at current playhead position (Shortcut: I)"
                  >
                    [ Set In (I)
                  </button>

                  <span
                    style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 11,
                      color: '#e2e8f0',
                      padding: '0 4px',
                    }}
                  >
                    {inMarker !== null ? `${inMarker.toFixed(1)}s` : '--'} →{' '}
                    {outMarker !== null ? `${outMarker.toFixed(1)}s` : '--'}
                    {inMarker !== null && outMarker !== null && (
                      <strong style={{ color: '#facc15', marginLeft: 5 }}>
                        ({markedDuration.toFixed(1)}s)
                      </strong>
                    )}
                  </span>

                  <button
                    className="btn"
                    style={{
                      padding: '4px 9px',
                      fontSize: 11.5,
                      borderColor: '#f59e0b',
                      background: 'rgba(245, 158, 11, 0.16)',
                      color: '#fcd34d',
                      fontWeight: 600,
                    }}
                    onClick={handleSetOutMarkerAtPlayhead}
                    title="Set OUT marker at current playhead position (Shortcut: O)"
                  >
                    Set Out (O) ]
                  </button>

                  {inMarker !== null && outMarker !== null && outMarker > inMarker && (
                    <>
                      <button
                        className="btn"
                        style={{
                          padding: '4px 8px',
                          fontSize: 11,
                          background: isLoopingInOut
                            ? 'rgba(250, 204, 21, 0.24)'
                            : 'var(--bg-card)',
                          borderColor: isLoopingInOut ? '#facc15' : 'var(--border-subtle)',
                          color: isLoopingInOut ? '#fef08a' : '#cbd5e1',
                        }}
                        onClick={() => handleTogglePlay(true)}
                        title="Loop playback strictly between In and Out markers"
                      >
                        <Play size={11} />
                        {isPlaying && isLoopingInOut ? 'Stop In→Out' : 'Preview In→Out'}
                      </button>

                      <button
                        className="btn btn-primary"
                        style={{
                          padding: '4px 10px',
                          fontSize: 11.5,
                        }}
                        onClick={() => handleCreateClipFromMarkers(true, false)}
                        title="Clip out the exact marked [In → Out] segment and open it on the timeline"
                      >
                        <Scissors size={12} />
                        Clip In→Out
                      </button>

                      <button
                        className="btn btn-purple"
                        style={{
                          padding: '4px 10px',
                          fontSize: 11.5,
                        }}
                        onClick={() => handleCreateClipFromMarkers(true, true)}
                        title={`Create a compilation cutdown (${activeScheme.targetClipDuration}s target) from the marked [In → Out] range`}
                      >
                        <Layers size={12} />
                        Compile In→Out ({activeScheme.targetClipDuration}s)
                      </button>
                    </>
                  )}
                </div>

                {/* Notice Toast */}
                {markerNotice && (
                  <span style={{ fontSize: 11.5, color: '#34d399', fontWeight: 600 }}>
                    ✓ {markerNotice}
                  </span>
                )}
              </div>

              {/* Timeline Header Ruler */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: 10.5,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  padding: '0 2px',
                }}
              >
                <span>00:00.0 (Start)</span>
                <span
                  style={{
                    color: isRazorMode
                      ? '#f87171'
                      : timelineMode === 'full-source'
                        ? '#34d399'
                        : '#93c5fd',
                    fontFamily: 'var(--font-ui)',
                    fontWeight: 600,
                  }}
                >
                  {isRazorMode
                    ? '✂ RAZOR BLADE ACTIVE — Click anywhere on the timeline below to slice at that timestamp (Press C to exit)'
                    : timelineMode === 'full-source'
                      ? `Full Uploaded Video Timeline (${activeClip.duration.toFixed(1)}s • ${activeClip.subCuts.length} ${activeClip.subCuts.length === 1 ? 'Cut' : 'Cuts'})`
                      : activeClip.clipCreationMode === 'condensed-edit'
                        ? `Compilation Cutdown Timeline • ${activeClip.subCuts.length} Stitched Highlight Shots (${activeClip.duration.toFixed(1)}s Total)`
                        : `Viral Clip Timeline • ${activeClip.subCuts.length} ${activeClip.subCuts.length === 1 ? 'Continuous Segment' : 'Cuts'} (${activeClip.duration.toFixed(1)}s Total)`}
                </span>
                <span>{activeClip.duration.toFixed(1)}s (End)</span>
              </div>

              {/* TIMELINE SCRUBBER BAR */}
              <div
                ref={timelineBarRef}
                style={{
                  position: 'relative',
                  height: 54,
                  background: '#111318',
                  border: isRazorMode
                    ? '1.5px solid #ef4444'
                    : timelineMode === 'full-source'
                      ? '1px solid rgba(16, 185, 129, 0.5)'
                      : '1px solid #334155',
                  borderRadius: 6,
                  cursor: isRazorMode ? 'crosshair' : 'pointer',
                  overflow: 'hidden',
                  display: 'flex',
                  userSelect: 'none',
                }}
                onMouseDown={(e) => {
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
                {/* Render the timeline segments */}
                {activeClip.subCuts.map((cut, idx) => {
                  const cutDur = Math.max(0.1, cut.timelineEnd - cut.timelineStart);
                  const widthPct = (cutDur / Math.max(0.5, activeClip.duration)) * 100;
                  const isCurrentCut =
                    clipPlayheadTime >= cut.timelineStart - 0.02 &&
                    clipPlayheadTime <= cut.timelineEnd + 0.02;
                  const isSelectedCut = idx === selectedCutIndex;

                  const totalBuckets = activeSource.waveformPeaks.length;
                  const bStart = Math.max(
                    0,
                    Math.floor((cut.sourceStart / Math.max(1, activeSource.duration)) * totalBuckets)
                  );
                  const bEnd = Math.max(
                    bStart + 2,
                    Math.ceil((cut.sourceEnd / Math.max(1, activeSource.duration)) * totalBuckets)
                  );
                  const slicePeaks = activeSource.waveformPeaks.slice(bStart, bEnd);

                  return (
                    <div
                      key={cut.id}
                      onClick={(e) => {
                        e.stopPropagation();
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
                          ? 'rgba(45, 140, 235, 0.32)'
                          : isCurrentCut
                            ? 'rgba(45, 140, 235, 0.2)'
                            : idx % 2 === 0
                              ? 'rgba(30, 41, 59, 0.78)'
                              : 'rgba(38, 52, 74, 0.78)',
                        borderRight:
                          idx < activeClip.subCuts.length - 1
                            ? '2px solid #facc15'
                            : 'none',
                        boxShadow: isSelectedCut
                          ? 'inset 0 0 0 1px rgba(96, 165, 250, 0.7)'
                          : 'none',
                        display: 'flex',
                        alignItems: 'flex-end',
                        padding: '0 2px',
                        gap: 1,
                        overflow: 'hidden',
                      }}
                      title={`${cut.label} | Source ${cut.sourceStart.toFixed(1)}s–${cut.sourceEnd.toFixed(1)}s`}
                    >
                      <div
                        style={{
                          position: 'absolute',
                          top: 3,
                          left: 6,
                          right: 4,
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          fontSize: 9.5,
                          fontWeight: 600,
                          color: isSelectedCut || isCurrentCut ? '#fff' : '#cbd5e1',
                          pointerEvents: 'none',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          zIndex: 2,
                        }}
                      >
                        <span>
                          {timelineMode === 'full-source' && activeClip.subCuts.length === 1
                            ? `FULL UPLOADED VIDEO (${activeSource.name})`
                            : cut.label}
                        </span>
                        {cut.zoom > 1.02 && (
                          <span
                            style={{
                              background: 'rgba(45, 140, 235, 0.45)',
                              color: '#e0f2fe',
                              padding: '0 4px',
                              borderRadius: 3,
                              fontSize: 8.5,
                            }}
                          >
                            {cut.zoom}x
                          </span>
                        )}
                      </div>

                      {slicePeaks.map((pk, pIdx) => (
                        <div
                          key={pIdx}
                          style={{
                            flex: 1,
                            height: `${Math.max(12, Math.round(pk * 68))}%`,
                            background:
                              isSelectedCut || isCurrentCut
                                ? 'rgba(96, 165, 250, 0.55)'
                                : 'rgba(148, 163, 184, 0.32)',
                            pointerEvents: 'none',
                          }}
                        />
                      ))}
                    </div>
                  );
                })}

                {/* IN / OUT MARKER SHADED SELECTION REGION & DRAGGABLE HANDLES */}
                {inMarkerPct !== null && outMarkerPct !== null && outMarkerPct >= inMarkerPct && (
                  <>
                    <div
                      style={{
                        position: 'absolute',
                        left: `${inMarkerPct}%`,
                        width: `${Math.max(0.5, outMarkerPct - inMarkerPct)}%`,
                        top: 0,
                        bottom: 0,
                        background: 'rgba(16, 185, 129, 0.18)',
                        borderTop: '2px solid #10b981',
                        borderBottom: '2px solid #f59e0b',
                        pointerEvents: 'none',
                        zIndex: 5,
                      }}
                    />

                    {/* Draggable IN Marker Handle */}
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
                        width: 12,
                        transform: 'translateX(-50%)',
                        cursor: isRazorMode ? 'crosshair' : 'ew-resize',
                        zIndex: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        pointerEvents: isRazorMode ? 'none' : 'auto',
                      }}
                      title={`Drag IN Marker (${inMarker?.toFixed(2)}s)`}
                    >
                      <div
                        style={{
                          background: '#10b981',
                          color: '#052e16',
                          fontSize: 8.5,
                          fontWeight: 800,
                          padding: '1px 4px',
                          borderRadius: 2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        IN
                      </div>
                      <div style={{ flex: 1, width: 2.5, background: '#10b981' }} />
                    </div>

                    {/* Draggable OUT Marker Handle */}
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
                        width: 12,
                        transform: 'translateX(-50%)',
                        cursor: isRazorMode ? 'crosshair' : 'ew-resize',
                        zIndex: 12,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        pointerEvents: isRazorMode ? 'none' : 'auto',
                      }}
                      title={`Drag OUT Marker (${outMarker?.toFixed(2)}s)`}
                    >
                      <div
                        style={{
                          background: '#f59e0b',
                          color: '#451a03',
                          fontSize: 8.5,
                          fontWeight: 800,
                          padding: '1px 4px',
                          borderRadius: 2,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        OUT
                      </div>
                      <div style={{ flex: 1, width: 2.5, background: '#f59e0b' }} />
                    </div>
                  </>
                )}

                {/* Live Razor Blade Cut Preview Line when hovering in Razor Mode */}
                {isRazorMode && razorHoverClipTime !== null && (
                  <div
                    style={{
                      position: 'absolute',
                      left: `${Math.max(
                        0,
                        Math.min(
                          100,
                          (razorHoverClipTime / Math.max(0.1, activeClip.duration)) * 100
                        )
                      )}%`,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      background: '#ef4444',
                      boxShadow: '0 0 8px #ef4444',
                      pointerEvents: 'none',
                      zIndex: 20,
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 2,
                        left: 4,
                        background: '#ef4444',
                        color: '#fff',
                        fontSize: 9,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 3,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      ✂ Cut @ {razorHoverClipTime.toFixed(1)}s
                    </div>
                  </div>
                )}

                {/* User Focus Lock Point Diamond Markers along the Timeline Scrubber Bar */}
                {userFocusAnchors.map((pt, idx) => {
                  const clipSec = sourceTimeToClipTime(activeClip, pt.time);
                  const pct = Math.max(
                    0,
                    Math.min(100, (clipSec / Math.max(0.1, activeClip.duration)) * 100)
                  );
                  const isNearCurrent = Math.abs(pt.time - playheadTime) < 0.35;
                  return (
                    <div
                      key={`timeline-focus-lock-${pt.time}-${idx}`}
                      onMouseDown={(e) => {
                        if (isRazorMode) return;
                        e.stopPropagation();
                        handleSeekSourceTime(pt.time);
                      }}
                      style={{
                        position: 'absolute',
                        left: `${pct}%`,
                        bottom: 2,
                        transform: 'translateX(-50%)',
                        background: isNearCurrent ? '#10b981' : 'rgba(6, 78, 59, 0.92)',
                        border: isNearCurrent ? '1.5px solid #fef08a' : '1px solid #34d399',
                        color: isNearCurrent ? '#052e16' : '#6ee7b7',
                        fontSize: 8.5,
                        fontWeight: 800,
                        padding: '1px 4px',
                        borderRadius: 3,
                        cursor: 'pointer',
                        zIndex: 14,
                        whiteSpace: 'nowrap',
                        boxShadow: '0 1px 4px rgba(0,0,0,0.65)',
                      }}
                      title={`Focus Lock #${idx + 1} @ ${pt.time.toFixed(2)}s — Click to jump here`}
                    >
                      ◆ {idx + 1}
                    </div>
                  );
                })}

                {/* Playhead Needle across the Active Timeline (0% to 100%) */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${Math.max(
                      0,
                      Math.min(100, (clipPlayheadTime / Math.max(0.1, activeClip.duration)) * 100)
                    )}%`,
                    top: 0,
                    bottom: 0,
                    width: 2.5,
                    background: '#60a5fa',
                    boxShadow: '0 0 8px rgba(96, 165, 250, 0.95)',
                    pointerEvents: 'none',
                    zIndex: 15,
                  }}
                />
              </div>

              {/* Fine-Tune Controls Row (with both Text/Number Inputs AND Sliders!) */}
              {timelineMode === 'full-source' ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr',
                    gap: 16,
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>In Marker [I]:</span>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0.5, (outMarker ?? activeSource.duration) - 0.5)}
                      step={0.1}
                      className="input-field"
                      style={{
                        width: 64,
                        padding: '2px 6px',
                        color: '#34d399',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                      }}
                      value={Number((inMarker ?? 0).toFixed(1))}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (Number.isFinite(val)) {
                          const clamped = Math.max(
                            0,
                            Math.min((outMarker ?? activeSource.duration) - 0.5, val)
                          );
                          setInMarker(clamped);
                          handleSeekSourceTime(clamped);
                        }
                      }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.5, (outMarker ?? activeSource.duration) - 0.5)}
                      step={0.1}
                      value={inMarker ?? 0}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setInMarker(val);
                        handleSeekSourceTime(val);
                      }}
                      style={{ flex: 1 }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>Out Marker [O]:</span>
                    <input
                      type="number"
                      min={Math.min(activeSource.duration, (inMarker ?? 0) + 0.5)}
                      max={activeSource.duration}
                      step={0.1}
                      className="input-field"
                      style={{
                        width: 64,
                        padding: '2px 6px',
                        color: '#fcd34d',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                      }}
                      value={Number((outMarker ?? activeSource.duration).toFixed(1))}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (Number.isFinite(val)) {
                          const clamped = Math.max(
                            (inMarker ?? 0) + 0.5,
                            Math.min(activeSource.duration, val)
                          );
                          setOutMarker(clamped);
                          handleSeekSourceTime(clamped);
                        }
                      }}
                    />
                    <input
                      type="range"
                      min={Math.min(activeSource.duration, (inMarker ?? 0) + 0.5)}
                      max={activeSource.duration}
                      step={0.1}
                      value={outMarker ?? activeSource.duration}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        setOutMarker(val);
                        handleSeekSourceTime(val);
                      }}
                      style={{ flex: 1 }}
                    />
                  </div>
                </div>
              ) : inspectedCut ? (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '1fr 1fr 1fr',
                    gap: 12,
                    fontSize: 11.5,
                    color: 'var(--text-secondary)',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      Cut #{inspectedCut.index} In:
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0.5, inspectedCut.sourceEnd - 0.5)}
                      step={0.1}
                      className="input-field"
                      style={{
                        width: 60,
                        padding: '2px 5px',
                        color: '#facc15',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                      }}
                      value={Number(inspectedCut.sourceStart.toFixed(1))}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        if (!Number.isFinite(val)) return;
                        const clamped = Math.max(0, Math.min(inspectedCut.sourceEnd - 0.5, val));
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
                    />
                    <input
                      type="range"
                      min={0}
                      max={Math.max(0.5, inspectedCut.sourceEnd - 0.5)}
                      step={0.1}
                      value={inspectedCut.sourceStart}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        updateActiveTimelineClip((c) => {
                          const updatedCuts = c.subCuts.map((sc) =>
                            sc.id === inspectedCut.id ? { ...sc, sourceStart: val } : sc
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
                        handleSeekSourceTime(val);
                      }}
                      style={{ flex: 1 }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>
                      Cut #{inspectedCut.index} Out:
                    </span>
                    <input
                      type="number"
                      min={Math.min(activeSource.duration, inspectedCut.sourceStart + 0.5)}
                      max={activeSource.duration}
                      step={0.1}
                      className="input-field"
                      style={{
                        width: 60,
                        padding: '2px 5px',
                        color: '#facc15',
                        fontWeight: 700,
                        fontFamily: 'var(--font-mono)',
                      }}
                      value={Number(inspectedCut.sourceEnd.toFixed(1))}
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
                    />
                    <input
                      type="range"
                      min={Math.min(activeSource.duration, inspectedCut.sourceStart + 0.5)}
                      max={activeSource.duration}
                      step={0.1}
                      value={inspectedCut.sourceEnd}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value);
                        updateActiveTimelineClip((c) => {
                          const updatedCuts = c.subCuts.map((sc) =>
                            sc.id === inspectedCut.id ? { ...sc, sourceEnd: val } : sc
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
                        handleSeekSourceTime(val);
                      }}
                      style={{ flex: 1 }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ whiteSpace: 'nowrap' }}>Caption:</span>
                    <input
                      type="text"
                      className="input-field"
                      style={{ padding: '4px 8px' }}
                      placeholder="Overlay caption..."
                      value={activeClip.captionText}
                      onChange={(e) =>
                        updateActiveTimelineClip((c) => ({ ...c, captionText: e.target.value }))
                      }
                    />
                  </div>
                </div>
              ) : null}
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Studio AI Agent ("Cut Copilot") */}
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
            outline: isDraggingChatFile ? '2px dashed #60a5fa' : undefined,
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
              <Bot size={15} color="#60a5fa" />
              3. Studio AI Agent
            </span>
            <span
              style={{
                fontSize: 10,
                color: '#34d399',
                background: 'rgba(16, 185, 129, 0.14)',
                border: '1px solid rgba(16, 185, 129, 0.35)',
                padding: '2px 7px',
                borderRadius: 4,
                fontWeight: 700,
              }}
            >
              ● {(aiSettings.models[aiSettings.activeProvider] || aiSettings.activeProvider).toUpperCase()}
            </span>
          </div>

          {/* Messages List */}
          <div
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: 12,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {chatMessages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  maxWidth: '92%',
                  padding: '9px 11px',
                  borderRadius: 8,
                  background:
                    msg.role === 'user' ? 'var(--accent-blue)' : 'var(--bg-card)',
                  border:
                    msg.role === 'user'
                      ? '1px solid #4ea1f5'
                      : '1px solid var(--border-subtle)',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                {msg.role === 'assistant' && msg.providerBadge && (
                  <div
                    style={{
                      fontSize: 9.5,
                      color: '#60a5fa',
                      fontWeight: 700,
                      marginBottom: 4,
                      letterSpacing: '0.2px',
                    }}
                  >
                    {msg.providerBadge}
                  </div>
                )}

                {/* Attached Images / Reference Videos / Files in Message */}
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
                          borderRadius: 6,
                          overflow: 'hidden',
                          border: '1px solid rgba(255,255,255,0.22)',
                          background: 'rgba(0,0,0,0.35)',
                          maxWidth: 180,
                        }}
                      >
                        {att.dataUrl ? (
                          <img
                            src={att.dataUrl}
                            alt={att.name}
                            style={{
                              display: 'block',
                              width: '100%',
                              maxHeight: 110,
                              objectFit: 'cover',
                            }}
                          />
                        ) : null}
                        <div
                          style={{
                            padding: '3px 6px',
                            fontSize: 10,
                            color: '#e2e8f0',
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

                <div style={{ color: '#fff' }}>{msg.content}</div>

                {msg.operationBadges && msg.operationBadges.length > 0 && (
                  <div
                    style={{
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: 5,
                      marginTop: 7,
                      alignItems: 'center',
                    }}
                  >
                    {msg.operationBadges.map((b, i) => (
                      <span
                        key={i}
                        style={{
                          fontSize: 10,
                          padding: '2px 6px',
                          borderRadius: 4,
                          background: 'rgba(45, 140, 235, 0.2)',
                          color: '#93c5fd',
                          fontWeight: 600,
                        }}
                      >
                        ✓ {b}
                      </span>
                    ))}

                    {msg.revisionSnapshotId && (
                      <button
                        className="btn"
                        style={{
                          padding: '2px 7px',
                          fontSize: 10,
                          marginLeft: 'auto',
                          color: '#fca5a5',
                        }}
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
                  padding: '8px 11px',
                  borderRadius: 8,
                  background: 'rgba(45, 140, 235, 0.12)',
                  border: '1px solid rgba(96, 165, 250, 0.35)',
                  fontSize: 11.5,
                  color: '#93c5fd',
                  fontWeight: 600,
                }}
              >
                ✨ {aiSettings.models[aiSettings.activeProvider] || 'Gemini 4 Argon'} is analyzing video frame & applying studio actions...
              </div>
            )}
          </div>

          {/* Quick Feedback Pills */}
          <div
            style={{
              padding: '8px 10px',
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 5,
              background: 'var(--bg-panel-header)',
            }}
          >
            {QUICK_FEEDBACK_CHIPS.map((chip) => (
              <button
                key={chip}
                onClick={() => handleSendChat(chip)}
                disabled={isCopilotBusy}
                style={{
                  fontSize: 11,
                  padding: '4px 8px',
                  borderRadius: 5,
                  border: '1px solid var(--border-subtle)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                {chip}
              </button>
            ))}
          </div>

          {/* Pending Attachments Bar (Pasted Images / Reference Videos / Files) */}
          {pendingChatAttachments.length > 0 && (
            <div
              style={{
                padding: '8px 10px',
                borderTop: '1px solid var(--border-subtle)',
                background: 'rgba(15, 23, 42, 0.85)',
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
                    gap: 6,
                    padding: '3px 7px 3px 4px',
                    borderRadius: 6,
                    background: '#1e293b',
                    border: '1px solid #475569',
                    fontSize: 10.5,
                    color: '#e2e8f0',
                    maxWidth: 175,
                  }}
                >
                  {att.dataUrl ? (
                    <img
                      src={att.dataUrl}
                      alt={att.name}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 4,
                        objectFit: 'cover',
                        flexShrink: 0,
                      }}
                    />
                  ) : att.kind === 'video' ? (
                    <Film size={14} color="#60a5fa" />
                  ) : (
                    <FileText size={14} color="#60a5fa" />
                  )}
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                    title={att.name}
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
                      color: '#94a3b8',
                      cursor: 'pointer',
                      padding: 2,
                      display: 'flex',
                      alignItems: 'center',
                    }}
                    title="Remove attachment"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Chat Input (Supports Ctrl+V Paste of Images/Files & File Attachment Button) */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if ((!chatInput.trim() && pendingChatAttachments.length === 0) || isCopilotBusy)
                return;
              handleSendChat(chatInput);
              setChatInput('');
            }}
            style={{
              padding: 10,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              gap: 6,
              background: 'var(--bg-panel-header)',
              alignItems: 'center',
            }}
          >
            <button
              type="button"
              className="btn"
              onClick={() => chatAttachmentInputRef.current?.click()}
              disabled={isCopilotBusy}
              title="Attach reference image, video, or script file (or paste with Ctrl+V)"
              style={{
                padding: '7px 8px',
                flexShrink: 0,
                border:
                  pendingChatAttachments.length > 0
                    ? '1px solid #60a5fa'
                    : '1px solid var(--border-subtle)',
                color: pendingChatAttachments.length > 0 ? '#60a5fa' : 'var(--text-secondary)',
              }}
            >
              <Paperclip size={14} />
            </button>
            <input
              type="text"
              className="input-field"
              placeholder="Paste image (Ctrl+V), attach file, or ask Agent..."
              value={chatInput}
              onPaste={handleChatPaste}
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={(!chatInput.trim() && pendingChatAttachments.length === 0) || isCopilotBusy}
            >
              <CornerDownLeft size={14} />
            </button>
          </form>
        </aside>
      </main>

      {/* Saved Projects Library Modal */}
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

      {/* AI Settings Modal */}
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
    </div>
  );
};

export default App;
