import React, { useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  MessageSquare,
  Pause,
  Play,
  Scissors,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import {
  AIProviderSettings,
  CopilotChatMessage,
  GeneratedClip,
  SourceVideoAsset,
} from '../types/editor';
import { formatSMPTETimecode } from '../services/clipGenerator';
import { getTrackingStateAtTime } from '../services/subjectTracker';
import { renderDemoSequenceFrame } from '../services/videoAnalyzer';
import { CutCopilotChat } from './CutCopilotChat';

interface ProgramMonitorProps {
  focused: boolean;
  onFocus: () => void;
  sourceAsset: SourceVideoAsset;
  masterVideoRef: React.RefObject<HTMLVideoElement>;
  frameVersion: number;
  activeClip: GeneratedClip | null;
  playheadTime: number; // source time in seconds
  isPlaying: boolean;
  onTogglePlay: () => void;
  onSeekSource: (time: number) => void;
  onSplitAtPlayhead: () => void;
  onExportClip: () => void;
  // Copilot props
  chatMessages: CopilotChatMessage[];
  aiSettings: AIProviderSettings;
  isCopilotBusy: boolean;
  onSendCopilotMessage: (prompt: string) => void;
  onRevertCopilotSnapshot: (snapshotId: string) => void;
  onOpenAISettings: () => void;
}

export const ProgramMonitor: React.FC<ProgramMonitorProps> = ({
  focused,
  onFocus,
  sourceAsset,
  masterVideoRef,
  frameVersion,
  activeClip,
  playheadTime,
  isPlaying,
  onTogglePlay,
  onSeekSource,
  onSplitAtPlayhead,
  onExportClip,
  chatMessages,
  aiSettings,
  isCopilotBusy,
  onSendCopilotMessage,
  onRevertCopilotSnapshot,
  onOpenAISettings,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [showCopilotDock, setShowCopilotDock] = useState(true);
  const [aspectPreviewMode, setAspectPreviewMode] = useState<'9:16-vertical' | '16:9-program'>(
    '9:16-vertical'
  );

  // Render live 9:16 reframed output with subject tracking, sub-cut zooms, captions & safe zones
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

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

    const vid = masterVideoRef.current;

    if (aspectPreviewMode === '9:16-vertical') {
      // Normalized 9:16 crop window inside 16:9 source
      const cropW = Math.min(0.95, 0.3164 / Math.max(1, cutZoom));
      const cropH = Math.min(0.98, 1.0 / Math.max(1, cutZoom));
      const sx = Math.max(0, Math.min(1 - cropW, track.cropX - cropW / 2));
      const sy = Math.max(0, Math.min(1 - cropH, track.cropY - cropH / 2));

      if (sourceAsset.isSyntheticDemo || !sourceAsset.url) {
        renderDemoSequenceFrame(ctx, w, h, playheadTime, {
          sx,
          sy,
          sw: cropW,
          sh: cropH,
        });
      } else if (vid && vid.readyState >= 2) {
        const vw = vid.videoWidth || 1920;
        const vh = vid.videoHeight || 1080;
        ctx.drawImage(
          vid,
          sx * vw,
          sy * vh,
          cropW * vw,
          cropH * vh,
          0,
          0,
          w,
          h
        );
      }
    } else {
      // Full 16:9 Program View with red graphic bounding box (like screenshot)
      if (sourceAsset.isSyntheticDemo || !sourceAsset.url) {
        renderDemoSequenceFrame(ctx, w, h, playheadTime);
      } else if (vid && vid.readyState >= 2) {
        ctx.drawImage(vid, 0, 0, w, h);
      }
    }

    // Draw Active Caption & Premiere Red Graphic Bounding Box
    if (activeClip) {
      const clipRelTime = Math.max(0, playheadTime - activeClip.sourceStart);
      const activeCaption = activeClip.captions.find(
        (c) => clipRelTime >= c.start && clipRelTime <= c.end
      );
      const captionStr = activeCaption?.text || activeClip.captionText;

      if (captionStr) {
        ctx.save();
        if (activeClip.captionStyle === 'cinema-serif') {
          ctx.font = '600 28px Georgia, serif';
          ctx.fillStyle = '#ffffff';
          ctx.fillText(captionStr, w * 0.14, h * 0.28);
          // Red Premiere Pro graphic bounding box matching the user's screenshot!
          ctx.strokeStyle = '#e04235';
          ctx.lineWidth = 1.5;
          ctx.strokeRect(w * 0.12, h * 0.21, w * 0.76, h * 0.28);
        } else if (activeClip.captionStyle === 'hormozi-bold') {
          ctx.textAlign = 'center';
          ctx.font = '800 20px Inter, sans-serif';
          ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
          ctx.fillRect(w * 0.08, h * 0.7 - 22, w * 0.84, 34);
          ctx.fillStyle = '#facc15';
          ctx.fillText(captionStr.toUpperCase(), w / 2, h * 0.7 + 2);
          ctx.strokeStyle = 'rgba(224, 66, 53, 0.85)';
          ctx.lineWidth = 1;
          ctx.strokeRect(w * 0.08, h * 0.7 - 22, w * 0.84, 34);
        } else if (activeClip.captionStyle === 'neon-karaoke') {
          ctx.textAlign = 'center';
          ctx.font = '700 19px Inter, sans-serif';
          ctx.shadowColor = '#38bdf8';
          ctx.shadowBlur = 10;
          ctx.fillStyle = '#ffffff';
          ctx.fillText(captionStr, w / 2, h * 0.72);
        } else {
          ctx.textAlign = 'center';
          ctx.font = '500 16px Inter, sans-serif';
          ctx.fillStyle = 'rgba(15, 15, 15, 0.8)';
          ctx.fillRect(w * 0.1, h * 0.76 - 18, w * 0.8, 26);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(captionStr, w / 2, h * 0.76);
        }
        ctx.restore();
      }

      // Draw TikTok / Reels / Shorts Safe Zone Overlay
      if (activeClip.safeZoneGuide !== 'none' && aspectPreviewMode === '9:16-vertical') {
        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(w * 0.06, h * 0.08, w * 0.88, h * 0.74);
        ctx.setLineDash([]);

        // Right-side social action icons placeholder (Like/Comment/Share safe area)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
        for (let i = 0; i < 4; i++) {
          ctx.beginPath();
          ctx.arc(w * 0.89, h * 0.48 + i * 34, 10, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
        ctx.font = '500 9px Inter, sans-serif';
        ctx.fillText(
          `${activeClip.safeZoneGuide.toUpperCase()} SAFE ZONE`,
          w * 0.08,
          h * 0.06
        );
        ctx.restore();
      }
    }
  }, [playheadTime, frameVersion, sourceAsset, activeClip, aspectPreviewMode, masterVideoRef]);

  const activeCut = activeClip?.subCuts.find(
    (c) => playheadTime >= c.sourceStart && playheadTime <= c.sourceEnd
  );

  return (
    <section
      className={`pr-panel ${focused ? 'focused' : ''}`}
      style={{ flex: 1.15 }}
      onMouseDown={onFocus}
    >
      {/* Program Monitor Header Tabs */}
      <div className="pr-panel-tabs" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button className="pr-panel-tab active">
            Program: {activeClip ? activeClip.name : sourceAsset.name} ≡
          </button>
          {activeClip && (
            <span
              style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 3,
                background: 'rgba(56, 178, 97, 0.18)',
                color: '#4ade80',
                fontWeight: 600,
              }}
            >
              Viral Score {activeClip.viralScore}%
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <button
            className={`pr-btn ${aspectPreviewMode === '9:16-vertical' ? 'pr-btn-primary' : ''}`}
            style={{ padding: '2px 7px', fontSize: 10 }}
            onClick={() =>
              setAspectPreviewMode((m) =>
                m === '9:16-vertical' ? '16:9-program' : '9:16-vertical'
              )
            }
            title="Switch between 9:16 Social Vertical Output and 16:9 Full Frame Program View"
          >
            <Smartphone size={11} />
            {aspectPreviewMode === '9:16-vertical' ? '9:16 Social Crop' : '16:9 Full Frame'}
          </button>

          <button
            className={`pr-btn ${showCopilotDock ? 'pr-btn-primary' : ''}`}
            style={{ padding: '2px 7px', fontSize: 10 }}
            onClick={() => setShowCopilotDock((v) => !v)}
            title="Toggle Cut Copilot Iterative Chat Panel"
          >
            <MessageSquare size={11} />
            Cut Copilot Chat
          </button>
        </div>
      </div>

      {/* Main Content Split: Left = Program Video Monitor + Transport, Right = Docked Cut Copilot Chat */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {/* Left Program Monitor Column */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <div className="pr-monitor-canvas-wrap">
            <canvas
              ref={canvasRef}
              width={aspectPreviewMode === '9:16-vertical' ? 304 : 640}
              height={aspectPreviewMode === '9:16-vertical' ? 540 : 360}
              style={{
                height: '94%',
                width: 'auto',
                maxWidth: '94%',
                aspectRatio: aspectPreviewMode === '9:16-vertical' ? '9 / 16' : '16 / 9',
                background: '#090909',
                border: '1px solid #2b2b2b',
                boxShadow: '0 6px 24px rgba(0,0,0,0.75)',
              }}
            />

            {/* Top-left telemetry badge */}
            {activeClip && (
              <div
                style={{
                  position: 'absolute',
                  top: 8,
                  left: 10,
                  background: 'rgba(15, 15, 15, 0.82)',
                  border: '1px solid #2e2e2e',
                  padding: '3px 7px',
                  borderRadius: 3,
                  fontSize: 10,
                  color: '#cfcfcf',
                }}
              >
                <div>
                  <strong style={{ color: '#46a3ff' }}>
                    {activeCut ? activeCut.label : '9:16 Sequence'}
                  </strong>{' '}
                  • Zoom {(activeCut?.zoom ?? activeClip.zoomScale).toFixed(2)}x
                </div>
                <div style={{ color: '#8f8f8f', fontSize: 9.5 }}>
                  Scheme: {activeClip.schemeName}
                </div>
              </div>
            )}
          </div>

          {/* Premiere Program Monitor Footer */}
          <div className="pr-monitor-footer">
            <div className="pr-monitor-status-row">
              <span className="pr-timecode">{formatSMPTETimecode(playheadTime)}</span>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <select className="pr-select" defaultValue="Fit" style={{ width: 56 }}>
                  <option value="Fit">Fit</option>
                  <option value="100%">100%</option>
                </select>
                <select className="pr-select" defaultValue="1/2" style={{ width: 52 }}>
                  <option value="Full">Full</option>
                  <option value="1/2">1/2</option>
                </select>
              </div>

              <span className="pr-timecode-muted">
                {formatSMPTETimecode(
                  activeClip ? activeClip.duration : sourceAsset.duration
                )}
              </span>
            </div>

            {/* Clip Scrubber with Sub-Cut Markers */}
            <div
              className="pr-scrubber-track"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                if (activeClip) {
                  onSeekSource(activeClip.sourceStart + ratio * activeClip.duration);
                } else {
                  onSeekSource(ratio * sourceAsset.duration);
                }
              }}
            >
              {activeClip?.subCuts.map((cut) => {
                const pct =
                  ((cut.sourceStart - activeClip.sourceStart) /
                    Math.max(0.1, activeClip.duration)) *
                  100;
                return (
                  <div
                    key={cut.id}
                    style={{
                      position: 'absolute',
                      left: `${Math.max(0, Math.min(100, pct))}%`,
                      top: 0,
                      bottom: 0,
                      width: 2,
                      background: cut.zoom > 1.05 ? '#facc15' : '#46a3ff',
                      pointerEvents: 'none',
                    }}
                    title={`${cut.label} (${cut.zoom}x)`}
                  />
                );
              })}

              <div
                className="pr-scrubber-playhead"
                style={{
                  left: `${
                    activeClip
                      ? Math.min(
                          100,
                          Math.max(
                            0,
                            ((playheadTime - activeClip.sourceStart) /
                              Math.max(0.1, activeClip.duration)) *
                              100
                          )
                        )
                      : (playheadTime / sourceAsset.duration) * 100
                  }%`,
                }}
              />
            </div>

            {/* Transport Controls */}
            <div className="pr-transport-row">
              <button
                className="pr-icon-btn"
                onClick={() =>
                  activeClip && onSeekSource(activeClip.sourceStart)
                }
                title="Jump to Clip In-Point"
              >
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>|&lt;</span>
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
                title="Play / Pause 9:16 Output"
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
                onClick={onSplitAtPlayhead}
                title="Razor Split Clip at Playhead (C)"
              >
                <Scissors size={12} />
              </button>
              <button
                className="pr-icon-btn"
                onClick={onExportClip}
                title="Export 9:16 Social Clip"
              >
                <Download size={12} />
              </button>
            </div>
          </div>
        </div>

        {/* Right Docked Cut Copilot Chat Window */}
        {showCopilotDock && (
          <CutCopilotChat
            messages={chatMessages}
            activeClip={activeClip}
            playheadTime={playheadTime}
            aiSettings={aiSettings}
            isSending={isCopilotBusy}
            onSendMessage={onSendCopilotMessage}
            onRevertSnapshot={onRevertCopilotSnapshot}
            onOpenAISettings={onOpenAISettings}
          />
        )}
      </div>
    </section>
  );
};
