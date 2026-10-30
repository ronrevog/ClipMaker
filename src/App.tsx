import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CornerDownLeft,
  Cpu,
  Crosshair,
  Download,
  Film,
  Plus,
  RotateCcw,
  Save,
  Scissors,
  Settings,
  Sparkles,
  Trash2,
  Upload,
  Volume2,
  VolumeX,
  Wand2,
  Play,
  Pause,
} from 'lucide-react';
import {
  AIProviderId,
  AIProviderSettings,
  CopilotChatMessage,
  CopilotRevisionSnapshot,
  EditingScheme,
  GeneratedClip,
  SourceVideoAsset,
  SubCut,
} from './types/editor';
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
  formatSMPTETimecode,
  generateClipsFromScheme,
  generateClipsWithMultimodalAI,
} from './services/clipGenerator';
import {
  computeDistortionFree9x16Crop,
  getTrackingStateAtTime,
} from './services/subjectTracker';
import { exportClipTo9x16Video } from './services/videoExporter';
import { AISettingsModal } from './components/AISettingsModal';

const QUICK_FEEDBACK_CHIPS = [
  'Start 2s earlier',
  'Trim 2s off end',
  'Move crop left',
  'Move crop right',
  'Center subject',
  'Zoom 1.25x',
  'Make cuts faster',
  'Split at playhead',
];

export const App: React.FC = () => {
  // 1. Editing Schemes & AI Settings (Gemini Default, Claude, OpenAI)
  const [schemes, setSchemes] = useState<EditingScheme[]>(() => loadSavedSchemes());
  const [activeScheme, setActiveScheme] = useState<EditingScheme>(() => loadSavedSchemes()[0]);
  const [aiSettings, setAiSettings] = useState<AIProviderSettings>(() => loadAISettings());
  const [isAISettingsOpen, setIsAISettingsOpen] = useState(false);
  const [schemeSavedNotice, setSchemeSavedNotice] = useState<string | null>(null);

  // 2. Uploaded Source Video & Generated 9:16 Clips (Starts clean — no fake cartoon video!)
  const [activeSource, setActiveSource] = useState<SourceVideoAsset | null>(null);
  const [generatedClips, setGeneratedClips] = useState<GeneratedClip[]>([]);
  const [activeClipId, setActiveClipId] = useState<string | null>(null);

  const activeClip =
    generatedClips.find((c) => c.id === activeClipId) || generatedClips[0] || null;

  // 3. Native Video Element & Playback State
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preview9x16CanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceOverlayWrapRef = useRef<HTMLDivElement | null>(null);

  const [nativeDims, setNativeDims] = useState<{ width: number; height: number }>({
    width: 1920,
    height: 1080,
  });
  const [playheadTime, setPlayheadTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isDraggingCrop, setIsDraggingCrop] = useState<boolean>(false);

  // 4. Progress & Busy States
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [analysisStatus, setAnalysisStatus] = useState<string>('');
  const [isCloningRef, setIsCloningRef] = useState<boolean>(false);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);

  // 5. Cut Copilot Chat State
  const [chatInput, setChatInput] = useState<string>('');
  const [isCopilotBusy, setIsCopilotBusy] = useState<boolean>(false);
  const [revisions, setRevisions] = useState<CopilotRevisionSnapshot[]>([]);
  const [chatMessages, setChatMessages] = useState<CopilotChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content:
        'Upload a video to automatically generate 9:16 clips with subject tracking. Then select any clip and tell me how you want to adjust the cuts, framing, zoom, or captions.',
      timestamp: new Date().toISOString(),
      providerBadge: 'Google Gemini ★',
    },
  ]);

  const sourceFileInputRef = useRef<HTMLInputElement | null>(null);
  const referenceFileInputRef = useRef<HTMLInputElement | null>(null);

  // Compute current active sub-cut & tracking crop rectangle
  const activeCut = activeClip?.subCuts.find(
    (c) => playheadTime >= c.sourceStart && playheadTime <= c.sourceEnd
  );
  const currentZoom = activeCut ? activeCut.zoom : activeClip?.zoomScale ?? 1.0;
  const currentCutBias = activeCut ? activeCut.cropBiasX : 0;

  const currentTrack = getTrackingStateAtTime(
    activeSource?.trackingSamples || [],
    playheadTime,
    (activeClip?.trackingOffsetX ?? 0) + currentCutBias,
    activeClip?.manualKeyframes ?? []
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
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outW, outH);

    const vw = vid.videoWidth || nativeDims.width;
    const vh = vid.videoHeight || nativeDims.height;

    const crop = computeDistortionFree9x16Crop(
      vw,
      vh,
      currentTrack.cropX,
      currentTrack.cropY,
      currentZoom
    );

    ctx.drawImage(vid, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, outW, outH);

    // Draw caption if present
    if (activeClip) {
      const relTime = Math.max(0, playheadTime - activeClip.sourceStart);
      const seg = activeClip.captions.find((c) => relTime >= c.start && relTime <= c.end);
      const text = seg?.text || activeClip.captionText;
      if (text) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.font = '800 22px Inter, sans-serif';
        ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
        ctx.fillRect(outW * 0.07, outH * 0.76 - 26, outW * 0.86, 40);
        ctx.fillStyle = '#facc15';
        ctx.fillText(text, outW / 2, outH * 0.76);
        ctx.restore();
      }
    }
  }, [nativeDims, currentTrack.cropX, currentTrack.cropY, currentZoom, activeClip, playheadTime]);

  useEffect(() => {
    render9x16Preview();
  }, [render9x16Preview, playheadTime]);

  // 60fps synchronization loop while video is playing
  useEffect(() => {
    if (!isPlaying) return;
    let rafId = 0;

    const tick = () => {
      const vid = videoRef.current;
      if (vid && activeSource) {
        const minT = activeClip ? activeClip.sourceStart : 0;
        const maxT = activeClip ? activeClip.sourceEnd : activeSource.duration;
        if (vid.currentTime >= maxT || vid.ended) {
          vid.currentTime = minT;
          if (vid.paused) vid.play().catch(() => {});
        }
        setPlayheadTime(vid.currentTime);
        render9x16Preview();
      }
      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlaying, activeSource, activeClip, render9x16Preview]);

  // Seek helper
  const handleSeek = useCallback(
    (time: number) => {
      if (!activeSource) return;
      const clamped = Math.max(0, Math.min(activeSource.duration, time));
      setPlayheadTime(clamped);
      if (videoRef.current) {
        videoRef.current.currentTime = clamped;
      }
    },
    [activeSource]
  );

  // Play / Pause helper
  const handleTogglePlay = useCallback(async () => {
    const vid = videoRef.current;
    if (!vid || !activeSource) return;
    if (isPlaying) {
      vid.pause();
      setIsPlaying(false);
    } else {
      if (activeClip) {
        if (vid.currentTime < activeClip.sourceStart || vid.currentTime >= activeClip.sourceEnd) {
          vid.currentTime = activeClip.sourceStart;
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
  }, [activeSource, isPlaying, activeClip, isMuted]);

  // Spacebar shortcut
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.code === 'Space') {
        e.preventDefault();
        handleTogglePlay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleTogglePlay]);

  const updateActiveClip = (updater: (clip: GeneratedClip) => GeneratedClip) => {
    if (!activeClip) return;
    setGeneratedClips((prev) =>
      prev.map((c) => (c.id === activeClip.id ? updater(c) : c))
    );
  };

  // Dragging the 9:16 crop box directly over the native video
  const handlePointerOnSourceVideo = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sourceOverlayWrapRef.current || !activeClip) return;
    const rect = sourceOverlayWrapRef.current.getBoundingClientRect();
    const normX = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));

    updateActiveClip((clip) => ({
      ...clip,
      manualKeyframes: [
        ...clip.manualKeyframes.filter((k) => Math.abs(k.time - playheadTime) > 0.35),
        { time: Number(playheadTime.toFixed(2)), cropX: normX, cropY: normY },
      ],
    }));
  };

  // Upload & Analyze Real Video
  const handleUploadVideoFile = async (file: File) => {
    if (videoRef.current) videoRef.current.pause();
    setIsPlaying(false);
    setIsAnalyzing(true);
    setAnalysisStatus('Loading video & decoding audio...');

    try {
      const analyzed = await analyzeUploadedVideo(file, (stage, pct) => {
        setAnalysisStatus(`${stage} (${pct}%)`);
      });

      setNativeDims({ width: analyzed.width, height: analyzed.height });
      setActiveSource(analyzed);

      // Immediately cut 9:16 clips from real high-energy audio windows & scene cuts
      const initialClips = generateClipsFromScheme(analyzed, activeScheme);
      setGeneratedClips(initialClips);
      if (initialClips[0]) {
        setActiveClipId(initialClips[0].id);
        setPlayheadTime(initialClips[0].sourceStart);
      }

      // Now call AI (Gemini / Claude / OpenAI) with real sampled frames + WAV audio
      setAnalysisStatus(
        `Running ${aiSettings.activeProvider.toUpperCase()} multimodal hook & transcript analysis...`
      );
      const aiRes = await generateClipsWithMultimodalAI(analyzed, activeScheme, aiSettings);
      const aiClips = aiRes.clips;
      if (aiClips && aiClips.length > 0) {
        setGeneratedClips(aiClips);
        setActiveClipId(aiClips[0].id);
        setPlayheadTime(aiClips[0].sourceStart);
        setChatMessages((prev) => [
          ...prev,
          {
            id: `ai-done-${Date.now()}`,
            role: 'assistant',
            content: `Analyzed "${file.name}" (${analyzed.width}×${analyzed.height}, ${analyzed.duration}s) with ${aiRes.providerUsed} and created ${aiClips.length} 9:16 clips with subject tracking.`,
            timestamp: new Date().toISOString(),
            providerBadge: aiRes.providerUsed,
            operationBadges: aiClips.map((c) => `${c.duration}s Clip`),
          },
        ]);
      } else {
        setChatMessages((prev) => [
          ...prev,
          {
            id: `local-done-${Date.now()}`,
            role: 'assistant',
            content: `Loaded "${file.name}" (${analyzed.width}×${analyzed.height}, ${analyzed.duration}s) and generated ${initialClips.length} 9:16 clips from audio energy peaks & scene cuts.${
              aiRes.error ? ` (${aiRes.error})` : ''
            }`,
            timestamp: new Date().toISOString(),
            providerBadge: 'Audio & Scene Analyzer',
            operationBadges: [`${initialClips.length} Clips Ready`, `${analyzed.width}×${analyzed.height} Native`],
          },
        ]);
      }
    } catch (err: any) {
      alert(`Failed to load video: ${err?.message || 'Unknown error'}`);
    } finally {
      setIsAnalyzing(false);
      setAnalysisStatus('');
    }
  };

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

      const nextSchemes = [scheme, ...schemes];
      setSchemes(nextSchemes);
      saveSchemesToStorage(nextSchemes);
      setActiveScheme(scheme);

      if (activeSource) {
        const reCut = generateClipsFromScheme(activeSource, scheme);
        setGeneratedClips(reCut);
        if (reCut[0]) {
          setActiveClipId(reCut[0].id);
          handleSeek(reCut[0].sourceStart);
        }
      }

      setChatMessages((prev) => [
        ...prev,
        {
          id: `ref-cloned-${Date.now()}`,
          role: 'assistant',
          content: `${styleSummary} Saved new Editing Scheme: "${scheme.name}".`,
          timestamp: new Date().toISOString(),
          providerBadge: providerUsed,
          operationBadges: [
            `Cloned: ${file.name}`,
            `${scheme.targetAvgShotLength}s ASL`,
            `${scheme.punchInZoom}x Zoom`,
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
  const handleSaveAndApplyScheme = (applyToVideo: boolean) => {
    setSchemes((prev) => {
      const exists = prev.some((s) => s.id === activeScheme.id);
      const next = exists
        ? prev.map((s) => (s.id === activeScheme.id ? activeScheme : s))
        : [activeScheme, ...prev];
      saveSchemesToStorage(next);
      return next;
    });

    if (applyToVideo && activeSource) {
      const fresh = generateClipsFromScheme(activeSource, activeScheme);
      setGeneratedClips(fresh);
      if (fresh[0]) {
        setActiveClipId(fresh[0].id);
        handleSeek(fresh[0].sourceStart);
      }
      setSchemeSavedNotice('Saved & re-cut 9:16 clips!');
    } else {
      setSchemeSavedNotice('Scheme saved!');
    }
    setTimeout(() => setSchemeSavedNotice(null), 2500);
  };

  // Split Active Clip at Playhead
  const handleSplitAtPlayhead = () => {
    if (!activeClip) return;
    if (
      playheadTime <= activeClip.sourceStart + 0.3 ||
      playheadTime >= activeClip.sourceEnd - 0.3
    ) {
      return;
    }

    updateActiveClip((clip) => {
      const nextSubCuts: SubCut[] = [];
      let idx = 1;
      for (const cut of clip.subCuts) {
        if (playheadTime > cut.sourceStart + 0.25 && playheadTime < cut.sourceEnd - 0.25) {
          const d1 = playheadTime - cut.sourceStart;
          nextSubCuts.push({
            ...cut,
            id: `${cut.id}-a-${Date.now()}`,
            index: idx++,
            sourceEnd: Number(playheadTime.toFixed(2)),
            timelineEnd: Number((cut.timelineStart + d1).toFixed(2)),
          });
          nextSubCuts.push({
            ...cut,
            id: `${cut.id}-b-${Date.now()}`,
            index: idx++,
            sourceStart: Number(playheadTime.toFixed(2)),
            timelineStart: Number((cut.timelineStart + d1).toFixed(2)),
            label: 'Split Cut',
            zoom: cut.zoom === 1 ? 1.2 : 1.0,
          });
        } else {
          nextSubCuts.push({ ...cut, index: idx++ });
        }
      }
      return { ...clip, subCuts: nextSubCuts };
    });
  };

  // Send Cut Iteration Feedback in Chat
  const handleSendChat = async (promptText: string) => {
    if (!promptText.trim()) return;
    if (!activeClip || !activeSource) {
      setChatMessages((prev) => [
        ...prev,
        {
          id: `u-${Date.now()}`,
          role: 'user',
          content: promptText,
          timestamp: new Date().toISOString(),
        },
        {
          id: `a-${Date.now() + 1}`,
          role: 'assistant',
          content: 'Please upload a video first so I have a clip on the timeline to edit.',
          timestamp: new Date().toISOString(),
        },
      ]);
      return;
    }

    const userMsg: CopilotChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: promptText,
      timestamp: new Date().toISOString(),
      clipId: activeClip.id,
      clipName: activeClip.name,
      playheadTime,
    };
    setChatMessages((prev) => [...prev, userMsg]);
    setIsCopilotBusy(true);

    const snapshotId = `snap-${Date.now()}`;
    const preEditSnapshot: CopilotRevisionSnapshot = {
      id: snapshotId,
      timestamp: new Date().toISOString(),
      clipSnapshot: JSON.parse(JSON.stringify(activeClip)),
      summaryBadges: [],
    };

    try {
      const provider = aiSettings.activeProvider;
      const resp = await fetch('/api/ai-copilot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          model: aiSettings.models[provider],
          apiKeyOverride: aiSettings.apiKeys[provider],
          userPrompt: promptText,
          activeClip: {
            id: activeClip.id,
            name: activeClip.name,
            sourceStart: activeClip.sourceStart,
            sourceEnd: activeClip.sourceEnd,
            duration: activeClip.duration,
            trackingMode: activeClip.trackingMode,
            trackingOffsetX: activeClip.trackingOffsetX,
            trackingSmoothing: activeClip.trackingSmoothing,
            zoomScale: activeClip.zoomScale,
            captionText: activeClip.captionText,
            cuts: activeClip.subCuts.map((c) => ({
              id: c.id,
              timeOffset: c.sourceStart,
              label: c.label,
              zoom: c.zoom,
              cropCenterX: c.cropBiasX,
            })),
          },
          currentPlayhead: playheadTime,
          schemeName: activeScheme.name,
        }),
      });

      const data = await resp.json();
      const operations = Array.isArray(data.operations) ? data.operations : [];
      const badges: string[] = [];

      updateActiveClip((clip) => {
        let next = { ...clip, subCuts: [...clip.subCuts] };

        for (const op of operations) {
          badges.push(op.summary || op.type);

          if (op.type === 'trim_start' && typeof op.deltaSeconds === 'number') {
            next.sourceStart = Number(
              Math.max(0, Math.min(next.sourceEnd - 2, next.sourceStart + op.deltaSeconds)).toFixed(2)
            );
            next.duration = Number((next.sourceEnd - next.sourceStart).toFixed(2));
            if (next.subCuts[0]) {
              next.subCuts[0] = { ...next.subCuts[0], sourceStart: next.sourceStart };
            }
          } else if (op.type === 'trim_end' && typeof op.deltaSeconds === 'number') {
            next.sourceEnd = Number(
              Math.min(
                activeSource.duration,
                Math.max(next.sourceStart + 2, next.sourceEnd + op.deltaSeconds)
              ).toFixed(2)
            );
            next.duration = Number((next.sourceEnd - next.sourceStart).toFixed(2));
            if (next.subCuts.length > 0) {
              const lastIdx = next.subCuts.length - 1;
              next.subCuts[lastIdx] = { ...next.subCuts[lastIdx], sourceEnd: next.sourceEnd };
            }
          } else if (op.type === 'adjust_tracking_offset' && typeof op.offsetX === 'number') {
            next.trackingOffsetX = Math.max(-0.35, Math.min(0.35, next.trackingOffsetX + op.offsetX));
          } else if (op.type === 'center_subject') {
            next.trackingOffsetX = 0;
            next.manualKeyframes = [];
          } else if (op.type === 'adjust_smoothing' && typeof op.smoothing === 'number') {
            next.trackingSmoothing = Math.max(0.15, Math.min(0.96, op.smoothing));
          } else if (op.type === 'set_zoom' && typeof op.zoom === 'number') {
            const z = Math.max(1.0, Math.min(1.5, op.zoom));
            next.zoomScale = z;
            next.subCuts = next.subCuts.map((c) =>
              playheadTime >= c.sourceStart && playheadTime <= c.sourceEnd
                ? { ...c, zoom: z }
                : c
            );
          } else if (op.type === 'repace_cuts' && typeof op.pacingMultiplier === 'number') {
            const newAsl = Math.max(
              0.8,
              Math.min(6.0, activeScheme.targetAvgShotLength * op.pacingMultiplier)
            );
            const rebuilt: SubCut[] = [];
            let cur = next.sourceStart;
            let tlCur = 0;
            let idx = 1;
            while (cur < next.sourceEnd - 0.3) {
              const endT = Math.min(next.sourceEnd, Number((cur + newAsl).toFixed(2)));
              const dur = Number((endT - cur).toFixed(2));
              rebuilt.push({
                id: `repace-${idx}-${Date.now()}`,
                index: idx,
                sourceStart: cur,
                sourceEnd: endT,
                timelineStart: tlCur,
                timelineEnd: Number((tlCur + dur).toFixed(2)),
                label: idx % 2 === 0 ? 'Punch-In Cut' : `Cut #${idx}`,
                zoom: idx % 2 === 0 ? next.zoomScale : 1.0,
                cropBiasX: 0,
              });
              cur = endT;
              tlCur += dur;
              idx++;
            }
            next.subCuts = rebuilt;
          } else if (op.type === 'update_caption' && op.captionText) {
            next.captionText = op.captionText;
          } else if (op.type === 'save_scheme_preset') {
            const presetName = op.schemePresetName || `Custom ${activeScheme.name}`;
            const saved: EditingScheme = {
              ...activeScheme,
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

      if (operations.some((o: any) => o.type === 'split_at_playhead')) {
        handleSplitAtPlayhead();
      }

      preEditSnapshot.summaryBadges = badges;
      setRevisions((prev) => [preEditSnapshot, ...prev]);

      setChatMessages((prev) => [
        ...prev,
        {
          id: `ast-${Date.now()}`,
          role: 'assistant',
          content: data.reply || 'Updated clip cuts and 9:16 framing.',
          timestamp: new Date().toISOString(),
          playheadTime,
          providerBadge: data.liveApiUsed
            ? `${data.providerUsed} [Live]`
            : `${data.providerUsed} Engine`,
          operationBadges: badges,
          revisionSnapshotId: snapshotId,
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
    setGeneratedClips((prev) =>
      prev.map((c) => (c.id === snap.clipSnapshot.id ? snap.clipSnapshot : c))
    );
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

      {/* Clean Professional Top Header Bar */}
      <header className="studio-topbar">
        <div className="studio-brand">
          <div className="studio-pr-badge">Pr</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.2px' }}>
              ClipMaker Studio
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
              9:16 Auto-Reframe, Custom Schemes &amp; Cut Copilot
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

        {/* Right Controls: Upload Video, Clone Reference Style, AI Provider Switcher, Export */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="btn"
            onClick={() => sourceFileInputRef.current?.click()}
            disabled={isAnalyzing}
          >
            <Upload size={14} color="#60a5fa" />
            {activeSource ? 'Upload Different Video' : 'Upload Video'}
          </button>

          <button
            className="btn btn-purple"
            onClick={() => referenceFileInputRef.current?.click()}
            disabled={isCloningRef}
            title="Upload any reference video to copy its cut speed and zoom style into a new Editing Scheme"
          >
            <Wand2 size={14} />
            Clone Reference Video Style
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
                    padding: '4px 9px',
                    fontSize: 11.5,
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                    background: active ? 'var(--accent-blue)' : 'transparent',
                    color: active ? '#fff' : 'var(--text-secondary)',
                  }}
                >
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
          >
            <Download size={14} />
            {isExporting ? `Exporting ${exportProgress}%...` : 'Export 9:16 Video'}
          </button>
        </div>
      </header>

      {/* Main 3-Column Studio Workspace */}
      <main className="studio-workspace">
        {/* LEFT COLUMN: Editing Schemes + Generated 9:16 Clips */}
        <aside className="studio-panel">
          <div className="studio-panel-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Sparkles size={14} color="#60a5fa" />
              1. Editing Scheme Criteria
            </span>
            <div style={{ display: 'flex', gap: 5 }}>
              <button
                className="btn"
                style={{ padding: '3px 8px', fontSize: 11 }}
                onClick={() => {
                  const fresh: EditingScheme = {
                    ...activeScheme,
                    id: `scheme-${Date.now()}`,
                    name: `Custom Scheme #${schemes.length + 1}`,
                    isBuiltIn: false,
                    createdAt: new Date().toISOString(),
                    clonedFromReference: undefined,
                  };
                  const next = [fresh, ...schemes];
                  setSchemes(next);
                  saveSchemesToStorage(next);
                  setActiveScheme(fresh);
                }}
              >
                <Plus size={12} />
                New
              </button>
              {!activeScheme.isBuiltIn && schemes.length > 1 && (
                <button
                  className="btn"
                  style={{ padding: '3px 7px', fontSize: 11, color: '#f87171' }}
                  onClick={() => {
                    const next = schemes.filter((s) => s.id !== activeScheme.id);
                    setSchemes(next);
                    saveSchemesToStorage(next);
                    setActiveScheme(next[0]);
                  }}
                >
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          </div>

          {/* Scheme Customizer Form */}
          <div
            style={{
              padding: 12,
              borderBottom: '1px solid var(--border-subtle)',
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            <div>
              <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                Selected Scheme Preset
              </label>
              <select
                className="select-field"
                value={activeScheme.id}
                onChange={(e) => {
                  const found = schemes.find((s) => s.id === e.target.value);
                  if (found) {
                    setActiveScheme(found);
                    if (activeSource) {
                      const clips = generateClipsFromScheme(activeSource, found);
                      setGeneratedClips(clips);
                      if (clips[0]) {
                        setActiveClipId(clips[0].id);
                        handleSeek(clips[0].sourceStart);
                      }
                    }
                  }
                }}
              >
                {schemes.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.clonedFromReference ? `★ [Cloned] ${s.name}` : s.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label style={{ fontSize: 11, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 }}>
                Scheme Name
              </label>
              <input
                type="text"
                className="input-field"
                value={activeScheme.name}
                onChange={(e) => setActiveScheme({ ...activeScheme, name: e.target.value })}
              />
            </div>

            {activeScheme.clonedFromReference && (
              <div
                style={{
                  padding: '6px 9px',
                  borderRadius: 6,
                  background: 'rgba(139, 92, 246, 0.14)',
                  border: '1px solid rgba(139, 92, 246, 0.35)',
                  fontSize: 11,
                  color: '#ddd6fe',
                }}
              >
                Cloned from <strong>{activeScheme.clonedFromReference.referenceFileName}</strong> (
                {activeScheme.clonedFromReference.averageShotLength}s ASL)
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Clip Length</span>
                  <strong style={{ color: '#60a5fa' }}>{activeScheme.targetClipDuration}s</strong>
                </div>
                <input
                  type="range"
                  min={8}
                  max={60}
                  value={activeScheme.targetClipDuration}
                  onChange={(e) =>
                    setActiveScheme({
                      ...activeScheme,
                      targetClipDuration: parseInt(e.target.value, 10),
                    })
                  }
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Cut Speed (ASL)</span>
                  <strong style={{ color: '#60a5fa' }}>
                    {activeScheme.targetAvgShotLength.toFixed(1)}s
                  </strong>
                </div>
                <input
                  type="range"
                  min={0.8}
                  max={6.0}
                  step={0.1}
                  value={activeScheme.targetAvgShotLength}
                  onChange={(e) =>
                    setActiveScheme({
                      ...activeScheme,
                      targetAvgShotLength: parseFloat(e.target.value),
                    })
                  }
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Track Smoothness</span>
                  <strong style={{ color: '#60a5fa' }}>
                    {Math.round(activeScheme.trackingSmoothing * 100)}%
                  </strong>
                </div>
                <input
                  type="range"
                  min={0.3}
                  max={0.96}
                  step={0.02}
                  value={activeScheme.trackingSmoothing}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setActiveScheme({ ...activeScheme, trackingSmoothing: val });
                    updateActiveClip((c) => ({ ...c, trackingSmoothing: val }));
                  }}
                  style={{ width: '100%' }}
                />
              </div>

              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Punch-In Zoom</span>
                  <strong style={{ color: '#60a5fa' }}>
                    {activeScheme.punchInZoom.toFixed(2)}x
                  </strong>
                </div>
                <input
                  type="range"
                  min={1.0}
                  max={1.4}
                  step={0.02}
                  value={activeScheme.punchInZoom}
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    setActiveScheme({ ...activeScheme, punchInZoom: val });
                    updateActiveClip((c) => ({ ...c, zoomScale: val }));
                  }}
                  style={{ width: '100%' }}
                />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn"
                style={{ flex: 1 }}
                onClick={() => handleSaveAndApplyScheme(false)}
              >
                <Save size={13} />
                Save Scheme
              </button>
              <button
                className="btn btn-primary"
                style={{ flex: 1 }}
                onClick={() => handleSaveAndApplyScheme(true)}
                disabled={!activeSource}
              >
                <Sparkles size={13} />
                Apply &amp; Re-Cut
              </button>
            </div>

            {schemeSavedNotice && (
              <div style={{ fontSize: 11.5, color: '#34d399', textAlign: 'center', fontWeight: 500 }}>
                ✓ {schemeSavedNotice}
              </div>
            )}
          </div>

          {/* Generated 9:16 Clips List */}
          <div className="studio-panel-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Film size={14} color="#60a5fa" />
              2. Generated 9:16 Clips ({generatedClips.length})
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
            {generatedClips.length === 0 ? (
              <div
                style={{
                  padding: 20,
                  textAlign: 'center',
                  color: 'var(--text-muted)',
                  fontSize: 12,
                  lineHeight: 1.5,
                }}
              >
                Upload a video to automatically generate ranked 9:16 clips here.
              </div>
            ) : (
              generatedClips.map((clip, index) => {
                const selected = clip.id === activeClip?.id;
                return (
                  <div
                    key={clip.id}
                    onClick={() => {
                      setActiveClipId(clip.id);
                      handleSeek(clip.sourceStart);
                    }}
                    style={{
                      padding: 10,
                      borderRadius: 6,
                      background: selected ? 'rgba(45, 140, 235, 0.16)' : 'var(--bg-card)',
                      border: selected
                        ? '1px solid var(--accent-blue)'
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
                      }}
                    >
                      <span style={{ fontWeight: 600, fontSize: 12.5 }}>
                        Clip #{index + 1} ({clip.duration.toFixed(1)}s)
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontWeight: 600,
                          padding: '1px 6px',
                          borderRadius: 4,
                          background: 'rgba(16, 185, 129, 0.16)',
                          color: '#34d399',
                        }}
                      >
                        Score {clip.viralScore}%
                      </span>
                    </div>
                    <div
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: '#93c5fd',
                        marginBottom: 3,
                      }}
                    >
                      {formatSMPTETimecode(clip.sourceStart).slice(3)} →{' '}
                      {formatSMPTETimecode(clip.sourceEnd).slice(3)} • {clip.subCuts.length} cuts
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                      {clip.hookReason}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        {/* CENTER STAGE: Native Source Video + 9:16 Output Preview + Simple Timeline Trim Bar */}
        <section className="studio-panel" style={{ display: 'flex', flexDirection: 'column' }}>
          <div className="studio-panel-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span>
                {activeSource
                  ? `Source: ${activeSource.name} (${nativeDims.width}×${nativeDims.height} Native)`
                  : 'Video Preview & 9:16 Subject Tracking'}
              </span>
              {activeSource && (
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--text-secondary)',
                    fontWeight: 400,
                  }}
                >
                  • Drag the blue 9:16 box on the source video to adjust centering
                </span>
              )}
            </div>

            {activeSource && (
              <span className="timecode-pill">
                {formatSMPTETimecode(playheadTime)} / {formatSMPTETimecode(activeSource.duration)}
              </span>
            )}
          </div>

          {/* Center Viewport */}
          {!activeSource ? (
            /* Clean Upload Dropzone when no video is uploaded yet */
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
                  Upload a Video to Start Creating 9:16 Clips
                </div>
                <div
                  style={{
                    fontSize: 13,
                    color: 'var(--text-secondary)',
                    maxWidth: 420,
                    lineHeight: 1.5,
                  }}
                >
                  Drag and drop any <strong>.mp4</strong>, <strong>.mov</strong>, or{' '}
                  <strong>.webm</strong> video here, or click to browse. Your video will display in
                  its true native aspect ratio alongside the live 9:16 tracked output.
                </div>
                <button className="btn btn-primary" style={{ marginTop: 6, padding: '9px 20px' }}>
                  <Upload size={15} />
                  Select Video File
                </button>
              </div>
            </div>
          ) : (
            /* Side-by-Side Native Source Video + Live 9:16 Cropped Output */
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 24,
                padding: 18,
                minHeight: 0,
                background: '#0d0e11',
                overflow: 'hidden',
              }}
            >
              {/* LEFT VIEWER: True Native Aspect Ratio Source Video + Interactive 9:16 Crop Box */}
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
                    color: 'var(--text-secondary)',
                    marginBottom: 6,
                    fontWeight: 600,
                    letterSpacing: '0.3px',
                  }}
                >
                  ORIGINAL SOURCE VIDEO ({nativeDims.width}×{nativeDims.height} NATIVE) + 9:16 TRACK
                </div>

                {/* Wrapper with exact native aspectRatio so overlay aligns 1:1 with video pixels and NEVER stretches */}
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
                    handlePointerOnSourceVideo(e);
                  }}
                  onMouseMove={(e) => {
                    if (isDraggingCrop) handlePointerOnSourceVideo(e);
                  }}
                  onMouseUp={() => setIsDraggingCrop(false)}
                  onMouseLeave={() => setIsDraggingCrop(false)}
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
                        videoRef.current.currentTime = activeClip.sourceStart;
                      }
                      render9x16Preview();
                    }}
                    onSeeked={() => render9x16Preview()}
                    style={{
                      width: '100%',
                      height: '100%',
                      display: 'block',
                      objectFit: 'contain',
                      pointerEvents: 'none',
                    }}
                  />

                  {/* Interactive 9:16 Subject Tracking Crop Box Overlay */}
                  <div
                    style={{
                      position: 'absolute',
                      left: `${currentCrop.normX * 100}%`,
                      top: `${currentCrop.normY * 100}%`,
                      width: `${currentCrop.normW * 100}%`,
                      height: `${currentCrop.normH * 100}%`,
                      border: currentTrack.isManualKeyframe
                        ? '2px solid #facc15'
                        : '2px solid #2d8ceb',
                      boxShadow: '0 0 0 9999px rgba(0, 0, 0, 0.48)',
                      pointerEvents: 'none',
                    }}
                  >
                    <div
                      style={{
                        position: 'absolute',
                        top: 4,
                        left: 4,
                        background: currentTrack.isManualKeyframe ? '#ca8a04' : '#2d8ceb',
                        color: '#fff',
                        fontSize: 9.5,
                        fontWeight: 700,
                        padding: '1px 5px',
                        borderRadius: 3,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      9:16 CROP • {currentZoom.toFixed(2)}x
                    </div>

                    {/* Center Subject Crosshair */}
                    <div
                      style={{
                        position: 'absolute',
                        left: '50%',
                        top: '50%',
                        width: 12,
                        height: 12,
                        transform: 'translate(-50%, -50%)',
                        border: '1.5px solid rgba(255,255,255,0.8)',
                        borderRadius: '50%',
                      }}
                    />
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
                    color: '#60a5fa',
                    marginBottom: 6,
                    fontWeight: 600,
                    letterSpacing: '0.3px',
                  }}
                >
                  9:16 SOCIAL OUTPUT PREVIEW
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
                    border: '2px solid #2d8ceb',
                    boxShadow: '0 10px 30px rgba(0,0,0,0.75)',
                  }}
                />
              </div>
            </div>
          )}

          {/* Simple, Rock-Solid Transport & Timeline Trim Bar */}
          {activeSource && activeClip && (
            <div
              style={{
                padding: '12px 16px',
                background: 'var(--bg-panel-header)',
                borderTop: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {/* Controls Row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button className="btn btn-primary" onClick={handleTogglePlay}>
                    {isPlaying ? <Pause size={14} /> : <Play size={14} />}
                    {isPlaying ? 'Pause' : 'Play Clip'}
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

                  <button
                    className="btn"
                    onClick={handleSplitAtPlayhead}
                    title="Split clip at current playhead position"
                  >
                    <Scissors size={14} />
                    Split Cut Here
                  </button>

                  <button
                    className="btn"
                    onClick={() =>
                      updateActiveClip((c) => ({
                        ...c,
                        trackingOffsetX: 0,
                        manualKeyframes: [],
                      }))
                    }
                    title="Reset manual crop overrides back to automatic subject centering"
                  >
                    <Crosshair size={14} />
                    Auto-Center Subject
                  </button>
                </div>

                {/* Caption Quick Input */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, maxWidth: 320 }}>
                  <span style={{ fontSize: 11.5, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    Caption:
                  </span>
                  <input
                    type="text"
                    className="input-field"
                    placeholder="Type overlay caption (optional)..."
                    value={activeClip.captionText}
                    onChange={(e) =>
                      updateActiveClip((c) => ({ ...c, captionText: e.target.value }))
                    }
                  />
                </div>
              </div>

              {/* Visual Scrubber & Clip In/Out Range Bar */}
              <div
                style={{
                  position: 'relative',
                  height: 38,
                  background: '#111318',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 6,
                  cursor: 'pointer',
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'flex-end',
                  padding: '0 2px',
                  gap: 1,
                }}
                onClick={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                  handleSeek(ratio * activeSource.duration);
                }}
              >
                {/* Audio Waveform Bars */}
                {activeSource.waveformPeaks.map((pk, idx) => (
                  <div
                    key={idx}
                    style={{
                      flex: 1,
                      height: `${Math.max(12, Math.round(pk * 85))}%`,
                      background: 'rgba(148, 163, 184, 0.25)',
                      pointerEvents: 'none',
                    }}
                  />
                ))}

                {/* Active Clip Highlight Window + Sub-Cut Dividers */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${(activeClip.sourceStart / activeSource.duration) * 100}%`,
                    width: `${((activeClip.sourceEnd - activeClip.sourceStart) / activeSource.duration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    background: 'rgba(45, 140, 235, 0.28)',
                    borderLeft: '3px solid #facc15',
                    borderRight: '3px solid #facc15',
                    pointerEvents: 'none',
                  }}
                />

                {/* Sub-Cut Markers */}
                {activeClip.subCuts.map((cut) => (
                  <div
                    key={cut.id}
                    style={{
                      position: 'absolute',
                      left: `${(cut.sourceStart / activeSource.duration) * 100}%`,
                      top: 0,
                      bottom: 0,
                      width: 1.5,
                      background: 'rgba(255, 255, 255, 0.5)',
                      pointerEvents: 'none',
                    }}
                  />
                ))}

                {/* Playhead Needle */}
                <div
                  style={{
                    position: 'absolute',
                    left: `${(playheadTime / activeSource.duration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 2.5,
                    background: '#60a5fa',
                    boxShadow: '0 0 8px #2d8ceb',
                    pointerEvents: 'none',
                  }}
                />
              </div>

              {/* Direct Clip Start & End Trim Sliders */}
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
                  <span style={{ whiteSpace: 'nowrap' }}>
                    Clip Start: <strong style={{ color: '#facc15' }}>{activeClip.sourceStart.toFixed(1)}s</strong>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={Math.max(0.5, activeClip.sourceEnd - 2)}
                    step={0.1}
                    value={activeClip.sourceStart}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      updateActiveClip((c) => ({
                        ...c,
                        sourceStart: val,
                        duration: Number((c.sourceEnd - val).toFixed(2)),
                      }));
                      handleSeek(val);
                    }}
                    style={{ flex: 1 }}
                  />
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ whiteSpace: 'nowrap' }}>
                    Clip End: <strong style={{ color: '#facc15' }}>{activeClip.sourceEnd.toFixed(1)}s</strong>
                  </span>
                  <input
                    type="range"
                    min={Math.min(activeSource.duration, activeClip.sourceStart + 2)}
                    max={activeSource.duration}
                    step={0.1}
                    value={activeClip.sourceEnd}
                    onChange={(e) => {
                      const val = parseFloat(e.target.value);
                      updateActiveClip((c) => ({
                        ...c,
                        sourceEnd: val,
                        duration: Number((val - c.sourceStart).toFixed(2)),
                      }));
                      handleSeek(val);
                    }}
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
            </div>
          )}
        </section>

        {/* RIGHT COLUMN: Cut Iteration Chat ("Cut Copilot") */}
        <aside className="studio-panel">
          <div className="studio-panel-header">
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Bot size={15} color="#60a5fa" />
              3. Cut Feedback Chat
            </span>
            <span
              style={{
                fontSize: 10.5,
                color: '#93c5fd',
                background: 'rgba(45, 140, 235, 0.14)',
                padding: '2px 7px',
                borderRadius: 4,
              }}
            >
              {aiSettings.activeProvider.toUpperCase()}
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

          {/* Chat Input */}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!chatInput.trim() || isCopilotBusy) return;
              handleSendChat(chatInput);
              setChatInput('');
            }}
            style={{
              padding: 10,
              borderTop: '1px solid var(--border-subtle)',
              display: 'flex',
              gap: 6,
              background: 'var(--bg-panel-header)',
            }}
          >
            <input
              type="text"
              className="input-field"
              placeholder="Give feedback on this clip or cut..."
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!chatInput.trim() || isCopilotBusy}
            >
              <CornerDownLeft size={14} />
            </button>
          </form>
        </aside>
      </main>

      {/* AI Settings Modal */}
      <AISettingsModal
        isOpen={isAISettingsOpen}
        settings={aiSettings}
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
