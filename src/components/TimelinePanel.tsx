import React, { useRef } from 'react';
import {
  Bookmark,
  Eye,
  Link2,
  Lock,
  Magnet,
  Mic,
  Scissors,
  Wrench,
} from 'lucide-react';
import {
  GeneratedClip,
  NLEToolId,
  SourceVideoAsset,
  SubCut,
} from '../types/editor';
import { formatSMPTETimecode } from '../services/clipGenerator';

interface TimelinePanelProps {
  focused: boolean;
  onFocus: () => void;
  sourceAsset: SourceVideoAsset;
  activeClip: GeneratedClip | null;
  allClips: GeneratedClip[];
  onSelectClip: (clip: GeneratedClip) => void;
  playheadTime: number;
  onSeekSource: (time: number) => void;
  activeTool: NLEToolId;
  onSplitAtTime: (sourceTime: number) => void;
  onSelectSubCut: (cut: SubCut) => void;
  onTrimClipBoundary: (edge: 'start' | 'end', deltaSeconds: number) => void;
}

export const TimelinePanel: React.FC<TimelinePanelProps> = ({
  focused,
  onFocus,
  sourceAsset,
  activeClip,
  allClips,
  onSelectClip,
  playheadTime,
  onSeekSource,
  activeTool,
  onSplitAtTime,
  onSelectSubCut,
  onTrimClipBoundary,
}) => {
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const totalDuration = Math.max(5, sourceAsset.duration);

  const handleRulerOrLaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const clickedTime = Number((ratio * totalDuration).toFixed(2));
    if (activeTool === 'razor') {
      onSplitAtTime(clickedTime);
    } else {
      onSeekSource(clickedTime);
    }
  };

  const playheadPct = Math.max(0, Math.min(100, (playheadTime / totalDuration) * 100));

  return (
    <section
      className={`pr-panel ${focused ? 'focused' : ''}`}
      style={{ flex: 1 }}
      onMouseDown={onFocus}
    >
      {/* Sequence Tabs Header */}
      <div className="pr-panel-tabs" style={{ justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
          {allClips.map((clip, i) => {
            const isSel = activeClip?.id === clip.id;
            return (
              <button
                key={clip.id}
                className={`pr-panel-tab ${isSel ? 'active' : ''}`}
                onClick={() => onSelectClip(clip)}
              >
                × 9:16 Seq #{i + 1} ({clip.duration.toFixed(0)}s) ≡
              </button>
            );
          })}
        </div>

        <span style={{ fontSize: 10, color: '#8e8e8e', paddingRight: 6 }}>
          {activeTool === 'razor'
            ? '✂ Razor Mode: Click any clip on V1 to split at timestamp'
            : 'Click ruler or V1 sub-cuts to scrub & inspect'}
        </span>
      </div>

      {/* Premiere Timeline Upper Sub-Toolbar (Timecode + Snap/Link Icons + Time Ruler) */}
      <div
        style={{
          display: 'flex',
          height: 44,
          background: '#202020',
          borderBottom: '1px solid #121212',
          flexShrink: 0,
        }}
      >
        {/* Left Header Box with Large Blue SMPTE Timecode & Snap/Link Icons */}
        <div
          style={{
            width: 145,
            flexShrink: 0,
            borderRight: '1px solid #121212',
            padding: '3px 8px',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div className="pr-timecode" style={{ fontSize: 13.5 }}>
            {formatSMPTETimecode(playheadTime)}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span title="Snap in Timeline (S)">
              <Magnet size={11} color="#46a3ff" />
            </span>
            <span title="Linked Selection">
              <Link2 size={11} color="#46a3ff" />
            </span>
            <span title="Add Marker (M)">
              <Bookmark size={11} color="#999" />
            </span>
            <span title="Timeline Display Settings">
              <Wrench size={11} color="#999" />
            </span>
          </div>
        </div>

        {/* Right Timecode Ruler */}
        <div
          ref={laneAreaRef}
          onClick={handleRulerOrLaneClick}
          style={{
            flex: 1,
            position: 'relative',
            background: '#1b1b1b',
            cursor: activeTool === 'razor' ? 'crosshair' : 'pointer',
            overflow: 'hidden',
          }}
        >
          {/* Yellow Work-Area Bar (matching screenshot!) */}
          {activeClip && (
            <div
              style={{
                position: 'absolute',
                left: `${(activeClip.sourceStart / totalDuration) * 100}%`,
                width: `${((activeClip.sourceEnd - activeClip.sourceStart) / totalDuration) * 100}%`,
                top: 2,
                height: 3,
                background: '#e5c029',
                borderRadius: 2,
              }}
            />
          )}

          {/* Ruler Timecode Labels & Tick Marks */}
          {[0, 0.2, 0.4, 0.6, 0.8, 1].map((frac, idx) => (
            <div
              key={idx}
              style={{
                position: 'absolute',
                left: `${frac * 100}%`,
                top: 7,
                fontSize: 9.5,
                fontFamily: 'var(--font-mono)',
                color: '#8c8c8c',
                transform: idx === 5 ? 'translateX(-100%)' : 'none',
                pointerEvents: 'none',
              }}
            >
              {formatSMPTETimecode(frac * totalDuration)}
            </div>
          ))}

          {/* Minor tick marks */}
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 8,
              backgroundImage:
                'repeating-linear-gradient(to right, #444 0, #444 1px, transparent 1px, transparent 18px)',
              pointerEvents: 'none',
            }}
          />

          {/* Blue Playhead Cap */}
          <div
            style={{
              position: 'absolute',
              left: `${playheadPct}%`,
              bottom: 0,
              width: 11,
              height: 14,
              background: '#2d8ceb',
              transform: 'translateX(-50%)',
              clipPath: 'polygon(0 0, 100% 0, 100% 65%, 50% 100%, 0 65%)',
              pointerEvents: 'none',
              zIndex: 20,
            }}
          />
        </div>
      </div>

      {/* Multi-Track Stack (V3, V2, V1 + Divider + A1, A2, Master) */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* V3 Track: Subject Tracking Keyframes & Safe-Zone Layer */}
        <div className="pr-track-row">
          <div className="pr-track-header">
            <Lock size={10} color="#777" />
            <span className="pr-track-pill">V3</span>
            <Eye size={11} color="#999" style={{ marginLeft: 'auto' }} />
          </div>
          <div className="pr-track-lane" onClick={handleRulerOrLaneClick}>
            {activeClip?.manualKeyframes.map((kf, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${(kf.time / totalDuration) * 100}%`,
                  top: 9,
                  width: 9,
                  height: 9,
                  background: '#facc15',
                  transform: 'translateX(-50%) rotate(45deg)',
                  border: '1px solid #000',
                }}
                title={`Manual 9:16 Tracking Keyframe @ ${kf.time.toFixed(2)}s`}
              />
            ))}
          </div>
        </div>

        {/* V2 Track: Pink/Magenta Graphic & Caption Blocks (matches V2 pink clip in screenshot!) */}
        <div className="pr-track-row">
          <div className="pr-track-header">
            <Lock size={10} color="#777" />
            <span className="pr-track-pill active">V2</span>
            <Eye size={11} color="#999" style={{ marginLeft: 'auto' }} />
          </div>
          <div className="pr-track-lane" onClick={handleRulerOrLaneClick}>
            {activeClip && (
              <div
                style={{
                  position: 'absolute',
                  left: `${((activeClip.sourceStart + activeClip.duration * 0.15) / totalDuration) * 100}%`,
                  width: `${Math.max(5, (activeClip.duration * 0.45 / totalDuration) * 100)}%`,
                  top: 3,
                  bottom: 3,
                  background: 'var(--pr-clip-graphic)',
                  border: '1px solid #efb8dc',
                  borderRadius: 2,
                  padding: '2px 5px',
                  fontSize: 9.5,
                  color: '#fff',
                  fontWeight: 600,
                  overflow: 'hidden',
                  whiteSpace: 'nowrap',
                }}
                title={`Graphic Overlay: ${activeClip.captionText}`}
              >
                {activeClip.captionText} [Graphic]
              </div>
            )}
          </div>
        </div>

        {/* V1 Track: Primary 9:16 Reframed Video Sub-Cuts (Slate Blue Premiere Clips) */}
        <div className="pr-track-row" style={{ height: 36 }}>
          <div className="pr-track-header">
            <Lock size={10} color="#777" />
            <span className="pr-track-pill active">V1</span>
            <Eye size={11} color="#999" style={{ marginLeft: 'auto' }} />
          </div>
          <div
            className="pr-track-lane"
            onClick={handleRulerOrLaneClick}
            style={{ cursor: activeTool === 'razor' ? 'crosshair' : 'pointer' }}
          >
            {/* Inactive Generated Clips shown dimly */}
            {allClips
              .filter((c) => c.id !== activeClip?.id)
              .map((clip) => (
                <div
                  key={clip.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectClip(clip);
                  }}
                  style={{
                    position: 'absolute',
                    left: `${(clip.sourceStart / totalDuration) * 100}%`,
                    width: `${((clip.sourceEnd - clip.sourceStart) / totalDuration) * 100}%`,
                    top: 6,
                    bottom: 6,
                    background: 'rgba(92, 127, 163, 0.22)',
                    border: '1px dashed rgba(125, 165, 206, 0.45)',
                    borderRadius: 2,
                    padding: '1px 4px',
                    fontSize: 9,
                    color: '#9bb4ce',
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                  }}
                  title={`Click to switch to ${clip.name}`}
                >
                  {clip.name}
                </div>
              ))}

            {/* Active 9:16 Clip with Sub-Cut Slices & Trim Handles */}
            {activeClip?.subCuts.map((cut) => {
              const leftPct = (cut.sourceStart / totalDuration) * 100;
              const widthPct = Math.max(0.8, ((cut.sourceEnd - cut.sourceStart) / totalDuration) * 100);
              const isCurrent =
                playheadTime >= cut.sourceStart && playheadTime <= cut.sourceEnd;

              return (
                <div
                  key={cut.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (activeTool === 'razor') {
                      const rect = laneAreaRef.current?.getBoundingClientRect();
                      if (rect) {
                        const r = (e.clientX - rect.left) / rect.width;
                        onSplitAtTime(Number((r * totalDuration).toFixed(2)));
                      }
                    } else {
                      onSelectSubCut(cut);
                      onSeekSource(cut.sourceStart + 0.05);
                    }
                  }}
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    top: 2,
                    bottom: 2,
                    background: isCurrent
                      ? 'var(--pr-clip-video-selected)'
                      : 'var(--pr-clip-video)',
                    border: isCurrent ? '1px solid #ffffff' : '1px solid #2b445e',
                    borderRadius: 2,
                    padding: '2px 5px',
                    fontSize: 9.5,
                    color: '#101820',
                    fontWeight: 600,
                    overflow: 'hidden',
                    whiteSpace: 'nowrap',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                  }}
                  title={`${cut.label}: ${cut.sourceStart}s - ${cut.sourceEnd}s (${cut.zoom}x zoom)`}
                >
                  <span>
                    {sourceAsset.name} [9:16 V1 • #{cut.index}]
                  </span>
                  {cut.zoom > 1.02 && (
                    <span
                      style={{
                        background: 'rgba(0,0,0,0.35)',
                        color: '#fff',
                        fontSize: 8.5,
                        padding: '0 3px',
                        borderRadius: 2,
                      }}
                    >
                      {cut.zoom}x
                    </span>
                  )}
                </div>
              );
            })}

            {/* In / Out Trim Nudge Buttons on Active Clip */}
            {activeClip && (
              <>
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onTrimClipBoundary('start', -1.0);
                  }}
                  style={{
                    position: 'absolute',
                    left: `${(activeClip.sourceStart / totalDuration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 5,
                    background: '#e5c029',
                    cursor: 'ew-resize',
                    zIndex: 5,
                  }}
                  title="Click to extend Clip In-Point earlier (-1s)"
                />
                <div
                  onClick={(e) => {
                    e.stopPropagation();
                    onTrimClipBoundary('end', 1.0);
                  }}
                  style={{
                    position: 'absolute',
                    left: `${(activeClip.sourceEnd / totalDuration) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 5,
                    background: '#e5c029',
                    cursor: 'ew-resize',
                    zIndex: 5,
                  }}
                  title="Click to extend Clip Out-Point later (+1s)"
                />
              </>
            )}
          </div>
        </div>

        {/* Video / Audio Track Divider Line */}
        <div style={{ height: 3, background: '#111111' }} />

        {/* A1 Track: Audio Waveform Clip Block */}
        <div className="pr-track-row" style={{ height: 36 }}>
          <div className="pr-track-header">
            <Lock size={10} color="#777" />
            <span className="pr-track-pill active">A1</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 5, fontSize: 9.5 }}>
              <b>M</b>
              <b>S</b>
              <Mic size={10} />
            </span>
          </div>
          <div className="pr-track-lane" onClick={handleRulerOrLaneClick}>
            {activeClip && (
              <div
                style={{
                  position: 'absolute',
                  left: `${(activeClip.sourceStart / totalDuration) * 100}%`,
                  width: `${((activeClip.sourceEnd - activeClip.sourceStart) / totalDuration) * 100}%`,
                  top: 2,
                  bottom: 2,
                  background: 'var(--pr-clip-audio)',
                  border: '1px solid #72c1ab',
                  borderRadius: 2,
                  overflow: 'hidden',
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: 1,
                  padding: '2px 3px',
                }}
              >
                {sourceAsset.waveformPeaks.slice(0, 75).map((pk, idx) => (
                  <div
                    key={idx}
                    style={{
                      flex: 1,
                      height: `${Math.max(18, Math.round(pk * 90))}%`,
                      background: 'rgba(215, 255, 242, 0.65)',
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* A2 Track: Beat & Audio Transient Markers */}
        <div className="pr-track-row">
          <div className="pr-track-header">
            <Lock size={10} color="#777" />
            <span className="pr-track-pill">A2</span>
            <span style={{ marginLeft: 'auto', display: 'flex', gap: 5, fontSize: 9.5 }}>
              <b>M</b>
              <b>S</b>
              <Mic size={10} />
            </span>
          </div>
          <div className="pr-track-lane" onClick={handleRulerOrLaneClick}>
            {sourceAsset.audioPeakTimestamps.map((beatT, i) => (
              <div
                key={i}
                style={{
                  position: 'absolute',
                  left: `${(beatT / totalDuration) * 100}%`,
                  top: 6,
                  bottom: 6,
                  width: 2,
                  background: 'rgba(72, 142, 123, 0.7)',
                }}
                title={`Audio Transient Peak @ ${beatT}s`}
              />
            ))}
          </div>
        </div>

        {/* Vertical Blue Playhead Line spanning all tracks */}
        <div
          style={{
            position: 'absolute',
            left: `calc(145px + (100% - 145px) * ${playheadPct / 100})`,
            top: 0,
            bottom: 0,
            width: 1.5,
            background: '#2d8ceb',
            pointerEvents: 'none',
            zIndex: 15,
          }}
        />
      </div>
    </section>
  );
};
