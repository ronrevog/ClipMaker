import React, { useEffect, useMemo, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';

interface WavesurferAudioTrackProps {
  audioUrl: string;
  clipStartTime: number;
  clipDuration: number;
  sourceDuration: number;
  clipPlayheadTime: number;
  isMuted: boolean;
  fallbackPeaks?: number[];
  isSelected?: boolean;
}

// Cache decoded 600-point waveform peaks per audioUrl so splitting cuts NEVER flickers or loses the waveform
const cachedAudioPeaksByUrl = new Map<string, number[]>();
const pendingDecodeByUrl = new Map<string, Promise<number[] | null>>();

async function decodeWaveformPeaksForUrl(audioUrl: string, numBuckets = 600): Promise<number[] | null> {
  if (!audioUrl) return null;
  const cached = cachedAudioPeaksByUrl.get(audioUrl);
  if (cached && cached.length > 0) return cached;

  const existingPromise = pendingDecodeByUrl.get(audioUrl);
  if (existingPromise) return existingPromise;

  const promise = (async () => {
    try {
      const resp = await fetch(audioUrl);
      const arrayBuf = await resp.arrayBuffer();
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return null;
      const ctx = new AudioCtx();
      let audioBuffer: AudioBuffer;
      try {
        audioBuffer = await ctx.decodeAudioData(arrayBuf.slice(0));
      } finally {
        try {
          await ctx.close();
        } catch {}
      }

      const raw = audioBuffer.getChannelData(0);
      if (!raw || raw.length === 0) return null;

      const samplesPerBucket = Math.max(1, Math.floor(raw.length / numBuckets));
      const peaks: number[] = [];
      let maxPeak = 0.01;

      for (let b = 0; b < numBuckets; b++) {
        const start = b * samplesPerBucket;
        const end = Math.min(raw.length, start + samplesPerBucket);
        const stride = Math.max(1, Math.floor((end - start) / 48));
        let sumSq = 0;
        let count = 0;
        let localMax = 0;
        for (let i = start; i < end; i += stride) {
          const v = Math.abs(raw[i]);
          if (v > localMax) localMax = v;
          sumSq += v * v;
          count++;
        }
        const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
        const combined = localMax * 0.65 + rms * 0.35;
        if (combined > maxPeak) maxPeak = combined;
        peaks.push(combined);
      }

      const normalized = peaks.map((p) =>
        Number(Math.max(0.1, Math.min(0.96, p / maxPeak)).toFixed(3))
      );
      cachedAudioPeaksByUrl.set(audioUrl, normalized);
      return normalized;
    } catch {
      return null;
    } finally {
      pendingDecodeByUrl.delete(audioUrl);
    }
  })();

  pendingDecodeByUrl.set(audioUrl, promise);
  return promise;
}

export const WavesurferAudioTrack: React.FC<WavesurferAudioTrackProps> = ({
  audioUrl,
  clipStartTime,
  clipDuration,
  sourceDuration,
  isMuted,
  fallbackPeaks,
  isSelected,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [decodedPeaks, setDecodedPeaks] = useState<number[] | null>(() =>
    audioUrl ? cachedAudioPeaksByUrl.get(audioUrl) || null : null
  );

  useEffect(() => {
    if (!audioUrl) return;
    let cancelled = false;
    decodeWaveformPeaksForUrl(audioUrl, 600).then((peaks) => {
      if (!cancelled && peaks && peaks.length > 0) {
        setDecodedPeaks(peaks);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [audioUrl]);

  useEffect(() => {
    if (!containerRef.current || !audioUrl) return;
    let destroyed = false;

    try {
      const ws = WaveSurfer.create({
        container: containerRef.current,
        height: 26,
        waveColor: isMuted
          ? 'rgba(239, 68, 68, 0.42)'
          : isSelected
            ? 'rgba(52, 211, 153, 0.85)'
            : 'rgba(16, 185, 129, 0.62)',
        progressColor: isMuted ? 'rgba(239, 68, 68, 0.55)' : 'rgba(52, 211, 153, 0.92)',
        cursorWidth: 0,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        interact: false,
        normalize: true,
        url: audioUrl,
      });

      ws.on('ready', () => {
        if (!destroyed) setIsReady(true);
      });

      wsRef.current = ws;
    } catch {
      // SVG waveform below serves as instant high-resolution renderer
    }

    return () => {
      destroyed = true;
      if (wsRef.current) {
        try {
          wsRef.current.destroy();
        } catch {}
        wsRef.current = null;
      }
    };
  }, [audioUrl]);

  useEffect(() => {
    if (!wsRef.current || !isReady) return;
    wsRef.current.setOptions({
      waveColor: isMuted
        ? 'rgba(239, 68, 68, 0.42)'
        : isSelected
          ? 'rgba(52, 211, 153, 0.85)'
          : 'rgba(16, 185, 129, 0.62)',
      progressColor: isMuted ? 'rgba(239, 68, 68, 0.55)' : 'rgba(52, 211, 153, 0.92)',
    });
  }, [isMuted, isSelected, isReady]);

  // Build exact sliced waveform bars for [clipStartTime, clipStartTime + clipDuration]
  const slicedBars = useMemo(() => {
    const sourcePeaks =
      decodedPeaks && decodedPeaks.length > 0
        ? decodedPeaks
        : fallbackPeaks && fallbackPeaks.length > 0
          ? fallbackPeaks
          : null;

    const safeTotalDur = Math.max(1, sourceDuration || clipDuration || 10);
    const startRatio = Math.max(0, Math.min(0.99, clipStartTime / safeTotalDur));
    const endRatio = Math.max(
      startRatio + 0.01,
      Math.min(1, (clipStartTime + Math.max(0.1, clipDuration)) / safeTotalDur)
    );

    const targetBarCount = 96;
    const bars: number[] = [];

    if (sourcePeaks && sourcePeaks.length > 0) {
      const startIdx = Math.floor(startRatio * sourcePeaks.length);
      const endIdx = Math.max(startIdx + 1, Math.ceil(endRatio * sourcePeaks.length));
      const span = Math.max(1, endIdx - startIdx);
      for (let i = 0; i < targetBarCount; i++) {
        const idx = Math.min(
          sourcePeaks.length - 1,
          startIdx + Math.floor((i / targetBarCount) * span)
        );
        bars.push(Math.max(0.14, Math.min(0.95, sourcePeaks[idx] || 0.25)));
      }
    } else {
      // Deterministic waveform shape if audio peaks are still decoding
      for (let i = 0; i < targetBarCount; i++) {
        const t = clipStartTime + (i / targetBarCount) * Math.max(0.5, clipDuration);
        const val =
          0.22 +
          0.42 * Math.abs(Math.sin(t * 3.7)) +
          0.25 * Math.abs(Math.cos(t * 9.3));
        bars.push(Math.max(0.14, Math.min(0.92, val)));
      }
    }
    return bars;
  }, [decodedPeaks, fallbackPeaks, clipStartTime, clipDuration, sourceDuration]);

  const widthMult =
    sourceDuration > 0 && clipDuration > 0
      ? Math.max(1, sourceDuration / Math.max(0.5, clipDuration))
      : 1;
  const offsetPct =
    sourceDuration > 0 ? Math.max(0, Math.min(95, (clipStartTime / sourceDuration) * 100)) : 0;

  const barColor = isMuted
    ? 'rgba(239, 68, 68, 0.45)'
    : isSelected
      ? 'rgba(52, 211, 153, 0.85)'
      : 'rgba(16, 185, 129, 0.62)';

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {/* Always-visible SVG waveform (never disappears or crushes to 0px when splitting tracks!) */}
      <svg
        viewBox={`0 0 ${slicedBars.length * 3} 28`}
        preserveAspectRatio="none"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          display: 'block',
          opacity: isReady ? 0.35 : 0.95,
        }}
      >
        {slicedBars.map((pk, idx) => {
          const h = Math.max(3, Math.round(pk * 23));
          const y = Math.round((28 - h) / 2);
          return (
            <rect
              key={idx}
              x={idx * 3 + 0.5}
              y={y}
              width={2}
              height={h}
              rx={1}
              fill={barColor}
            />
          );
        })}
      </svg>

      {/* Native WaveSurfer canvas overlay */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: isReady ? 0.92 : 0,
          transition: 'opacity 150ms ease',
        }}
      >
        <div
          ref={containerRef}
          style={{
            width: `${widthMult * 100}%`,
            transform: `translateX(-${offsetPct}%)`,
            height: '100%',
          }}
        />
      </div>
    </div>
  );
};
