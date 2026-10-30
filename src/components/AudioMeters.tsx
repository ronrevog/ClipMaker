import React from 'react';
import { SourceVideoAsset } from '../types/editor';

interface AudioMetersProps {
  sourceAsset: SourceVideoAsset;
  playheadTime: number;
  isPlaying: boolean;
}

const DB_LABELS = ['0', '-6', '-12', '-18', '-24', '-30', '-36', '-42', '-48', '-54'];

export const AudioMeters: React.FC<AudioMetersProps> = ({
  sourceAsset,
  playheadTime,
  isPlaying,
}) => {
  const bucketIdx = Math.min(
    sourceAsset.waveformPeaks.length - 1,
    Math.max(
      0,
      Math.floor((playheadTime / Math.max(1, sourceAsset.duration)) * sourceAsset.waveformPeaks.length)
    )
  );
  const basePeak = sourceAsset.waveformPeaks[bucketIdx] ?? 0.45;
  const activeLevelL = isPlaying
    ? Math.min(98, Math.max(12, Math.round(basePeak * 92 + Math.sin(playheadTime * 19) * 6)))
    : Math.round(basePeak * 65);
  const activeLevelR = isPlaying
    ? Math.min(98, Math.max(12, Math.round(basePeak * 89 + Math.cos(playheadTime * 15) * 7)))
    : Math.round(basePeak * 62);

  return (
    <aside
      className="pr-panel"
      style={{
        width: 52,
        flexShrink: 0,
        background: '#1a1a1a',
        padding: '6px 4px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}
    >
      <div style={{ flex: 1, display: 'flex', gap: 4, minHeight: 0 }}>
        {/* Left & Right LED Meter Columns */}
        <div
          style={{
            display: 'flex',
            gap: 3,
            flex: 1,
            background: '#101010',
            padding: 2,
            border: '1px solid #2a2a2a',
          }}
        >
          {[activeLevelL, activeLevelR].map((lvl, ch) => (
            <div
              key={ch}
              style={{
                flex: 1,
                position: 'relative',
                background: '#161616',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: `${lvl}%`,
                  background:
                    'linear-gradient(to top, #22c55e 0%, #22c55e 70%, #eab308 88%, #ef4444 100%)',
                  transition: 'height 0.08s ease-out',
                }}
              />
            </div>
          ))}
        </div>

        {/* dB Scale Readout */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            fontSize: 8.5,
            color: '#888',
            fontFamily: 'var(--font-mono)',
            padding: '2px 0',
          }}
        >
          {DB_LABELS.map((db) => (
            <span key={db}>{db}</span>
          ))}
        </div>
      </div>

      {/* Bottom S S Solo Indicators matching screenshot */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-around',
          marginTop: 4,
          paddingTop: 3,
          borderTop: '1px solid #2b2b2b',
          fontSize: 9,
          color: '#999',
          fontWeight: 700,
        }}
      >
        <span>S</span>
        <span>S</span>
      </div>
    </aside>
  );
};
