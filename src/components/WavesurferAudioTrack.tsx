import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';

interface WavesurferAudioTrackProps {
  audioUrl: string;
  clipStartTime: number;
  clipDuration: number;
  sourceDuration: number;
  clipPlayheadTime: number;
  isMuted: boolean;
}

export const WavesurferAudioTrack: React.FC<WavesurferAudioTrackProps> = ({
  audioUrl,
  clipStartTime,
  clipDuration,
  sourceDuration,
  isMuted,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current || !audioUrl) return;
    let destroyed = false;

    try {
      const ws = WaveSurfer.create({
        container: containerRef.current,
        height: 26,
        waveColor: isMuted ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.55)',
        progressColor: isMuted ? 'rgba(239, 68, 68, 0.5)' : 'rgba(52, 211, 153, 0.85)',
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
      // Fallback handled by parent
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
      waveColor: isMuted ? 'rgba(239, 68, 68, 0.35)' : 'rgba(16, 185, 129, 0.55)',
      progressColor: isMuted ? 'rgba(239, 68, 68, 0.5)' : 'rgba(52, 211, 153, 0.85)',
    });
  }, [isMuted, isReady]);

  const widthMult =
    sourceDuration > 0 && clipDuration > 0
      ? Math.max(1, sourceDuration / Math.max(0.5, clipDuration))
      : 1;
  const offsetPct =
    sourceDuration > 0 ? Math.max(0, Math.min(95, (clipStartTime / sourceDuration) * 100)) : 0;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        pointerEvents: 'none',
        opacity: isReady ? 0.92 : 0,
        transition: 'opacity 180ms ease',
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
  );
};
