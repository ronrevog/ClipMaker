import React, { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  Camera,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Pause,
  Play,
  RotateCcw,
  Sliders,
  Sparkles,
  Upload,
  Wand2,
} from 'lucide-react';
import {
  AIProviderSettings,
  EditingScheme,
  GeneratedClip,
  ReferenceVideoAnalysis,
  SourceVideoAsset,
} from '../types/editor';
import { formatSMPTETimecode } from '../services/clipGenerator';
import { getTrackingStateAtTime } from '../services/subjectTracker';
import { renderDemoSequenceFrame } from '../services/videoAnalyzer';
import { ReferenceClonerPanel } from './ReferenceClonerPanel';
import { SchemeEditorPanel } from './SchemeEditorPanel';

export type LeftMonitorTabId = 'source' | 'reference-clone' | 'schemes' | 'effects';

interface SourceMonitorProps {
  focused: boolean;
  onFocus: () => void;
  activeTab: LeftMonitorTabId;
  onSelectTab: (tab: LeftMonitorTabId) => void;
  sourceAsset: SourceVideoAsset;
  masterVideoRef: React.RefObject<HTMLVideoElement>;
  frameVersion: number;
  activeClip: GeneratedClip | null;
  playheadTime: number; // source time in seconds
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeekSource: (time: number) => void;
  onAddManualTrackingKeyframe: (time: number, cropX: number, cropY: number) => void;
  onResetManualKeyframes: () => void;
  onUpdateActiveClipProps: (patch: Partial<GeneratedClip>) => void;
  onUploadSourceFile: (file: File) => void;
  // Scheme & Reference props
  schemes: EditingScheme[];
  activeScheme: EditingScheme;
  onSelectScheme: (scheme: EditingScheme) => void;
  onSaveScheme: (scheme: EditingScheme, applyImmediately?: boolean) => void;
  onDeleteScheme: (schemeId: string) => void;
  referenceAnalyses: ReferenceVideoAnalysis[];
  activeReference: ReferenceVideoAnalysis | null;
  onSelectReference: (ref: ReferenceVideoAnalysis) => void;
  onUploadReferenceFile: (file: File) => void;
  onSynthesizeReferenceScheme: (
    ref: ReferenceVideoAnalysis,
    notes: string,
    applyImmediately: boolean
  ) => Promise<void>;
  isAnalyzingVideo: boolean;
  analysisStatusText: string;
  aiSettings: AIProviderSettings;
}

export const SourceMonitor: React.FC<SourceMonitorProps> = ({
  focused,
  onFocus,
  activeTab,
  onSelectTab,
  sourceAsset,
  masterVideoRef,
  frameVersion,
  activeClip,
  playheadTime,
  isPlaying,
  onTogglePlay,
  onSeekSource,
  onAddManualTrackingKeyframe,
  onResetManualKeyframes,
  onUpdateActiveClipProps,
  onUploadSourceFile,
  schemes,
  activeScheme,
  onSelectScheme,
  onSaveScheme,
  onDeleteScheme,
  referenceAnalyses,
  activeReference,
  onSelectReference,
  onUploadReferenceFile,
  onSynthesizeReferenceScheme,
  isAnalyzingVideo,
  analysisStatusText,
  aiSettings,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isDraggingCrop, setIsDraggingCrop] = useState(false);
  const [showTrackingOverlay, setShowTrackingOverlay] = useState(true);

  // Draw 16:9 Source frame + 9:16 Subject Tracking Crop Box overlay
  useEffect(() => {
    if (activeTab !== 'source') return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const vid = masterVideoRef.current;
    if (sourceAsset.isSyntheticDemo || !sourceAsset.url) {
      renderDemoSequenceFrame(ctx, w, h, playheadTime);
    } else if (vid && vid.readyState >= 2) {
      ctx.drawImage(vid, 0, 0, w, h);
    } else {
      ctx.fillStyle = '#111';
      ctx.fillRect(0, 0, w, h);
    }

    if (showTrackingOverlay) {
      const activeCut = activeClip?.subCuts.find(
        (c) => playheadTime >= c.sourceStart && playheadTime <= c.sourceEnd
      );
      const cutZoom = activeCut ? activeCut.zoom : activeClip?.zoomScale ?? 1.0;
      const cutBias = activeCut ? activeCut.cropBiasX : 0;

      const track = getTrackingStateAtTime(
        sourceAsset.trackingSamples,
        playheadTime,
        (activeClip?.trackingOffsetX ?? 0) + cutBias,
        activeClip?.manualKeyframes ?? []
      );

      // Normalized 9:16 crop width in 16:9 space is 0.3164 / zoom
      const normCropW = Math.min(0.92, 0.3164 / Math.max(1, cutZoom));
      const normCropH = Math.min(0.96, 0.96 / Math.max(1, cutZoom));

      const boxW = normCropW * w;
      const boxH = normCropH * h;
      const boxX = Math.max(0, Math.min(w - boxW, track.cropX * w - boxW / 2));
      const boxY = Math.max(0, Math.min(h - boxH, track.cropY * h - boxH / 2));

      // Dim outside of the 9:16 crop window slightly so editor clearly sees reframing
      ctx.fillStyle = 'rgba(0, 0, 0, 0.42)';
      ctx.fillRect(0, 0, boxX, h);
      ctx.fillRect(boxX + boxW, 0, w - (boxX + boxW), h);
      ctx.fillRect(boxX, 0, boxW, boxY);
      ctx.fillRect(boxX, boxY + boxH, boxW, h - (boxY + boxH));

      // Draw smooth subject trajectory lookahead path
      ctx.save();
      ctx.strokeStyle = 'rgba(45, 140, 235, 0.65)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let dt = -1.5; dt <= 1.5; dt += 0.25) {
        const sampleT = Math.max(0, Math.min(sourceAsset.duration, playheadTime + dt));
        const pt = getTrackingStateAtTime(
          sourceAsset.trackingSamples,
          sampleT,
          (activeClip?.trackingOffsetX ?? 0) + cutBias,
          activeClip?.manualKeyframes ?? []
        );
        const px = pt.cropX * w;
        const py = pt.cropY * h;
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      ctx.stroke();
      ctx.restore();

      // 9:16 Crop Bounding Box (Premiere Blue or Gold if manual keyframe)
      ctx.strokeStyle = track.isManualKeyframe ? '#facc15' : '#2d8ceb';
      ctx.lineWidth = 2;
      ctx.strokeRect(boxX, boxY, boxW, boxH);

      // Rule-of-thirds inner grid inside 9:16 crop box
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(boxX + boxW / 3, boxY);
      ctx.lineTo(boxX + boxW / 3, boxY + boxH);
      ctx.moveTo(boxX + (boxW * 2) / 3, boxY);
      ctx.lineTo(boxX + (boxW * 2) / 3, boxY + boxH);
      ctx.moveTo(boxX, boxY + boxH / 3);
      ctx.lineTo(boxX + boxW, boxY + boxH / 3);
      ctx.moveTo(boxX, boxY + (boxH * 2) / 3);
      ctx.lineTo(boxX + boxW, boxY + (boxH * 2) / 3);
      ctx.stroke();

      // Raw detected subject reticle (+)
      const rawPx = track.rawX * w;
      const rawPy = track.rawY * h;
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rawPx, rawPy, 7, 0, Math.PI * 2);
      ctx.moveTo(rawPx - 12, rawPy);
      ctx.lineTo(rawPx + 12, rawPy);
      ctx.moveTo(rawPx, rawPy - 12);
      ctx.lineTo(rawPx, rawPy + 12);
      ctx.stroke();

      // Header badge on 9:16 crop box
      ctx.fillStyle = track.isManualKeyframe ? '#ca8a04' : '#2d8ceb';
      ctx.fillRect(boxX, Math.max(0, boxY - 18), Math.min(boxW, 168), 18);
      ctx.fillStyle = '#ffffff';
      ctx.font = '600 10px Inter, sans-serif';
      ctx.fillText(
        `9:16 TRACK • ${track.subjectLabel.toUpperCase()} (${Math.round(track.confidence * 100)}%)`,
        boxX + 5,
        Math.max(12, boxY - 5)
      );
    }
  }, [
    activeTab,
    playheadTime,
    frameVersion,
    sourceAsset,
    activeClip,
    showTrackingOverlay,
    masterVideoRef,
  ]);

  const handleCanvasPointer = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const normX = Math.max(0.16, Math.min(0.84, (e.clientX - rect.left) / rect.width));
    const normY = Math.max(0.25, Math.min(0.75, (e.clientY - rect.top) / rect.height));
    onAddManualTrackingKeyframe(playheadTime, normX, normY);
  };

  return (
    <section
      className={`pr-panel ${focused ? 'focused' : ''}`}
      style={{ flex: 1 }}
      onMouseDown={onFocus}
    >
      {/* Top Panel Tabs matching Premiere Pro screenshot + Reference Clone & Schemes */}
      <div className="pr-panel-tabs">
        <button
          className={`pr-panel-tab ${activeTab === 'source' ? 'active' : ''}`}
          onClick={() => onSelectTab('source')}
        >
          Source: {sourceAsset.name} ≡
        </button>
        <button
          className={`pr-panel-tab ${activeTab === 'schemes' ? 'active' : ''}`}
          onClick={() => onSelectTab('schemes')}
        >
          <Sparkles size={11} color="#46a3ff" />
          Editing Schemes ({schemes.length})
        </button>
        <button
          className={`pr-panel-tab ${activeTab === 'reference-clone' ? 'active' : ''}`}
          onClick={() => onSelectTab('reference-clone')}
        >
          <Wand2 size={11} color="#a78bfa" />
          Reference Style Cloner
        </button>
        <button
          className={`pr-panel-tab ${activeTab === 'effects' ? 'active' : ''}`}
          onClick={() => onSelectTab('effects')}
        >
          <Sliders size={11} />
          Effect Controls
        </button>
      </div>

      {/* TAB 1: 16:9 Source Monitor with Live 9:16 Subject Tracking Box */}
      {activeTab === 'source' && (
        <>
          <div className="pr-monitor-canvas-wrap">
            {isAnalyzingVideo && (
              <div
                style={{
                  position: 'absolute',
                  top: 10,
                  left: 10,
                  zIndex: 10,
                  background: 'rgba(18, 18, 18, 0.9)',
                  border: '1px solid #2d8ceb',
                  padding: '6px 12px',
                  borderRadius: 4,
                  color: '#46a3ff',
                  fontSize: 11,
                  fontWeight: 500,
                }}
              >
                {analysisStatusText}
              </div>
            )}

            <canvas
              ref={canvasRef}
              width={640}
              height={360}
              style={{
                width: '92%',
                height: 'auto',
                maxHeight: '92%',
                aspectRatio: '16 / 9',
                background: '#0d0d0d',
                cursor: 'crosshair',
                boxShadow: '0 4px 20px rgba(0,0,0,0.65)',
              }}
              title="Click or drag anywhere on the 16:9 source frame to place a manual 9:16 subject tracking keyframe"
              onMouseDown={(e) => {
                setIsDraggingCrop(true);
                handleCanvasPointer(e);
              }}
              onMouseMove={(e) => {
                if (isDraggingCrop) handleCanvasPointer(e);
              }}
              onMouseUp={() => setIsDraggingCrop(false)}
              onMouseLeave={() => setIsDraggingCrop(false)}
            />

            {/* Floating overlay legend */}
            <div
              style={{
                position: 'absolute',
                bottom: 8,
                left: 12,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
                background: 'rgba(15,15,15,0.78)',
                padding: '3px 8px',
                borderRadius: 3,
                fontSize: 10,
                color: '#bdbdbd',
              }}
            >
              <span style={{ color: '#46a3ff', fontWeight: 600 }}>■ 9:16 Reframe Window</span>
              <span style={{ color: '#ef4444' }}>⊕ Detected Subject Centroid</span>
              <span>Click frame to keyframe center</span>
            </div>
          </div>

          {/* Premiere Monitor Footer */}
          <div className="pr-monitor-footer">
            <div className="pr-monitor-status-row">
              <span className="pr-timecode">{formatSMPTETimecode(playheadTime)}</span>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <select className="pr-select" defaultValue="Fit" style={{ width: 58 }}>
                  <option value="Fit">Fit</option>
                  <option value="50%">50%</option>
                  <option value="100%">100%</option>
                </select>

                <button
                  className={`pr-icon-btn ${showTrackingOverlay ? 'active' : ''}`}
                  onClick={() => setShowTrackingOverlay((v) => !v)}
                  title="Toggle 9:16 Subject Tracking Box Overlay"
                >
                  <Crosshair size={13} />
                </button>

                <button
                  className="pr-icon-btn"
                  onClick={onResetManualKeyframes}
                  title="Reset Manual Tracking Keyframes to Auto-Tracker"
                >
                  <RotateCcw size={12} />
                </button>

                <select className="pr-select" defaultValue="1/2" style={{ width: 52 }}>
                  <option value="Full">Full</option>
                  <option value="1/2">1/2</option>
                  <option value="1/4">1/4</option>
                </select>
              </div>

              <span className="pr-timecode-muted">
                {formatSMPTETimecode(sourceAsset.duration)}
              </span>
            </div>

            {/* Scrubber Ruler with Scene Cut & Audio Peak Markers */}
            <div
              className="pr-scrubber-track"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                onSeekSource(ratio * sourceAsset.duration);
              }}
            >
              {/* Active clip range highlight in Source Monitor */}
              {activeClip && (
                <div
                  style={{
                    position: 'absolute',
                    left: `${(activeClip.sourceStart / sourceAsset.duration) * 100}%`,
                    width: `${((activeClip.sourceEnd - activeClip.sourceStart) / sourceAsset.duration) * 100}%`,
                    top: 2,
                    bottom: 2,
                    background: 'rgba(45, 140, 235, 0.24)',
                    borderLeft: '2px solid #46a3ff',
                    borderRight: '2px solid #46a3ff',
                    pointerEvents: 'none',
                  }}
                />
              )}

              {/* Scene cut markers */}
              {sourceAsset.sceneCutTimestamps.map((sc, i) => (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${(sc / sourceAsset.duration) * 100}%`,
                    top: 0,
                    height: 6,
                    width: 2,
                    background: '#f59e0b',
                    pointerEvents: 'none',
                  }}
                  title={`Scene Cut @ ${sc}s`}
                />
              ))}

              {/* Playhead shuttle */}
              <div
                className="pr-scrubber-playhead"
                style={{
                  left: `${Math.min(100, Math.max(0, (playheadTime / sourceAsset.duration) * 100))}%`,
                }}
              />
            </div>

            {/* Transport Row */}
            <div className="pr-transport-row">
              <label
                className="pr-btn"
                style={{ marginRight: 'auto', cursor: 'pointer', padding: '2px 8px' }}
                title="Upload a new 16:9 source video file"
              >
                <Upload size={11} />
                Upload Video
                <input
                  type="file"
                  accept="video/*"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) onUploadSourceFile(f);
                  }}
                />
              </label>

              <button
                className="pr-icon-btn"
                onClick={() =>
                  onAddManualTrackingKeyframe(playheadTime, 0.5, 0.5)
                }
                title="Add Center Tracking Marker"
              >
                <Bookmark size={12} />
              </button>
              <button
                className="pr-icon-btn"
                onClick={() =>
                  activeClip &&
                  onUpdateActiveClipProps({
                    sourceStart: Number(Math.min(playheadTime, activeClip.sourceEnd - 2).toFixed(2)),
                    duration: Number(
                      (activeClip.sourceEnd - Math.min(playheadTime, activeClip.sourceEnd - 2)).toFixed(2)
                    ),
                  })
                }
                title="Mark In {"
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{'{'}</span>
              </button>
              <button
                className="pr-icon-btn"
                onClick={() =>
                  activeClip &&
                  onUpdateActiveClipProps({
                    sourceEnd: Number(Math.max(playheadTime, activeClip.sourceStart + 2).toFixed(2)),
                    duration: Number(
                      (Math.max(playheadTime, activeClip.sourceStart + 2) - activeClip.sourceStart).toFixed(2)
                    ),
                  })
                }
                title="Mark Out }"
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{'}'}</span>
              </button>
              <button
                className="pr-icon-btn"
                onClick={() => onSeekSource(Math.max(0, playheadTime - 1 / 30))}
                title="Step Back 1 Frame"
              >
                <ChevronLeft size={14} />
              </button>
              <button
                className="pr-icon-btn active"
                onClick={onTogglePlay}
                title="Play / Pause (Space)"
              >
                {isPlaying ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <button
                className="pr-icon-btn"
                onClick={() =>
                  onSeekSource(Math.min(sourceAsset.duration, playheadTime + 1 / 30))
                }
                title="Step Forward 1 Frame"
              >
                <ChevronRight size={14} />
              </button>
              <button
                className="pr-icon-btn"
                style={{ marginLeft: 'auto' }}
                title="Snapshot Frame"
              >
                <Camera size={12} />
              </button>
            </div>
          </div>
        </>
      )}

      {/* TAB 2: Editing Schemes Customizer & Manager */}
      {activeTab === 'schemes' && (
        <SchemeEditorPanel
          schemes={schemes}
          activeScheme={activeScheme}
          onSelectScheme={onSelectScheme}
          onSaveScheme={onSaveScheme}
          onDeleteScheme={onDeleteScheme}
        />
      )}

      {/* TAB 3: Reference Video Style Cloner */}
      {activeTab === 'reference-clone' && (
        <ReferenceClonerPanel
          referenceAnalyses={referenceAnalyses}
          activeReference={activeReference}
          onSelectReference={onSelectReference}
          onUploadReferenceFile={onUploadReferenceFile}
          onSynthesizeReferenceScheme={onSynthesizeReferenceScheme}
          aiSettings={aiSettings}
        />
      )}

      {/* TAB 4: Effect Controls (Fine-grained Tracking, Crop Bias, Zoom & Captions for Active Clip) */}
      {activeTab === 'effects' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
          {!activeClip ? (
            <div style={{ color: '#888' }}>Select a 9:16 clip to adjust Effect Controls.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div
                style={{
                  padding: '6px 10px',
                  background: '#1a1a1a',
                  borderLeft: '3px solid #2d8ceb',
                  fontWeight: 600,
                }}
              >
                Effect Controls • {activeClip.name}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '165px 1fr 55px',
                  gap: 8,
                  alignItems: 'center',
                  background: '#1c1c1c',
                  padding: 10,
                  borderRadius: 4,
                }}
              >
                <span style={{ color: '#b5b5b5' }}>9:16 Horizontal Crop Bias</span>
                <input
                  type="range"
                  min={-0.3}
                  max={0.3}
                  step={0.01}
                  value={activeClip.trackingOffsetX}
                  onChange={(e) =>
                    onUpdateActiveClipProps({ trackingOffsetX: parseFloat(e.target.value) })
                  }
                />
                <span className="pr-timecode">
                  {Math.round(activeClip.trackingOffsetX * 100)}%
                </span>

                <span style={{ color: '#b5b5b5' }}>Tracking Spring Smoothing</span>
                <input
                  type="range"
                  min={0.15}
                  max={0.96}
                  step={0.02}
                  value={activeClip.trackingSmoothing}
                  onChange={(e) =>
                    onUpdateActiveClipProps({ trackingSmoothing: parseFloat(e.target.value) })
                  }
                />
                <span className="pr-timecode">
                  {Math.round(activeClip.trackingSmoothing * 100)}%
                </span>

                <span style={{ color: '#b5b5b5' }}>Punch-In Scale (Zoom)</span>
                <input
                  type="range"
                  min={1.0}
                  max={1.45}
                  step={0.01}
                  value={activeClip.zoomScale}
                  onChange={(e) =>
                    onUpdateActiveClipProps({ zoomScale: parseFloat(e.target.value) })
                  }
                />
                <span className="pr-timecode">{activeClip.zoomScale.toFixed(2)}x</span>

                <span style={{ color: '#b5b5b5' }}>Primary Overlay Caption</span>
                <input
                  type="text"
                  className="pr-input"
                  value={activeClip.captionText}
                  onChange={(e) => onUpdateActiveClipProps({ captionText: e.target.value })}
                />
                <span style={{ fontSize: 10, color: '#777' }}>V3 Track</span>

                <span style={{ color: '#b5b5b5' }}>Social Safe-Zone Guide</span>
                <select
                  className="pr-select"
                  value={activeClip.safeZoneGuide}
                  onChange={(e) =>
                    onUpdateActiveClipProps({ safeZoneGuide: e.target.value as any })
                  }
                >
                  <option value="tiktok">TikTok Safe Zone</option>
                  <option value="reels">Instagram Reels Safe Zone</option>
                  <option value="shorts">YouTube Shorts Safe Zone</option>
                  <option value="none">None (Clean 9:16)</option>
                </select>
                <span style={{ fontSize: 10, color: '#777' }}>Guide</span>
              </div>

              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 10px',
                  background: '#1a1a1a',
                  borderRadius: 4,
                }}
              >
                <span style={{ color: '#9e9e9e' }}>
                  Manual Tracking Keyframes on Clip: {activeClip.manualKeyframes.length}
                </span>
                <button className="pr-btn" onClick={onResetManualKeyframes}>
                  <RotateCcw size={11} />
                  Clear Manual Keyframes
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
