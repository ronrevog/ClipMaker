import React, { useRef } from 'react';
import {
  Bookmark,
  Eye,
  Link2,
  Lock,
  Magnet,
  Mic,
  Wrench,
} from 'lucide-react';
import {
  GeneratedClip,
  NLEToolId,
  SourceVideoAsset,
  SubCut,
} from '../types/editor';
import {
  clipTimeToSourceTime,
  formatSMPTETimecode,
  sourceTimeToClipTime,
} from '../services/clipGenerator';

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
}) => {
  const laneAreaRef = useRef<HTMLDivElement | null>(null);
  const clipDuration = Math.max(1, activeClip ? activeClip.duration : sourceAsset.duration);
  const clipPlayhead = activeClip
    ? sourceTimeToClipTime(activeClip, playheadTime)
    : playheadTime;

  const handleRulerOrLaneClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetClipTime = ratio * clipDuration;
    const mappedSourceTime = activeClip
      ? clipTimeToSourceTime(activeClip, targetClipTime).sourceTime
      : targetClipTime;

    if (activeTool === 'razor') {
      onSplitAtTime(mappedSourceTime);
    } else {
      onSeekSource(mappedSourceTime);
    }
  };

  const playheadPct = Math.max(0, Math.min(100, (clipPlayhead / clipDuration) * 100));

  return (
    <section
      className={`pr-panel ${focused ? 'focused' : ''}`}
      style={{ flex: 1 }}
      onMouseDown={onFocus}
    >
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
          Elected Clip Sequence Timeline (0:00 → {formatSMPTETimecode(clipDuration).slice(3)})
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          height: 44,
          background: '#202020',
          borderBottom: '1px solid #121212',
          flexShrink: 0,
        }}
      >
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
            {formatSMPTETimecode(clipPlayhead)}
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
              {formatSMPTETimecode(frac * clipDuration)}
            </div>
          ))}

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

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
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
            {activeClip?.subCuts.map((cut) => {
              const leftPct = (cut.timelineStart / clipDuration) * 100;
              const widthPct = Math.max(
                0.8,
                ((cut.timelineEnd - cut.timelineStart) / clipDuration) * 100
              );
              const isCurrent =
                clipPlayhead >= cut.timelineStart && clipPlayhead <= cut.timelineEnd;

              return (
                <div
                  key={cut.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectSubCut(cut);
                    onSeekSource(cut.sourceStart + 0.02);
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
                  title={`${cut.label}: Source ${cut.sourceStart}s - ${cut.sourceEnd}s`}
                >
                  <span>
                    #{cut.index} {cut.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div style={{ height: 3, background: '#111111' }} />

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
            {activeClip?.subCuts.map((cut) => {
              const leftPct = (cut.timelineStart / clipDuration) * 100;
              const widthPct = Math.max(
                0.8,
                ((cut.timelineEnd - cut.timelineStart) / clipDuration) * 100
              );
              const totalPeaks = sourceAsset.waveformPeaks.length;
              const startIdx = Math.max(
                0,
                Math.floor((cut.sourceStart / Math.max(1, sourceAsset.duration)) * totalPeaks)
              );
              const endIdx = Math.max(
                startIdx + 1,
                Math.ceil((cut.sourceEnd / Math.max(1, sourceAsset.duration)) * totalPeaks)
              );
              const cutPeaks = sourceAsset.waveformPeaks.slice(startIdx, endIdx);

              return (
                <div
                  key={`a-${cut.id}`}
                  style={{
                    position: 'absolute',
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
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
                  {cutPeaks.map((pk, idx) => (
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
              );
            })}
          </div>
        </div>

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
