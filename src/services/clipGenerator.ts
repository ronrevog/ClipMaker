import {
  AIProviderSettings,
  CaptionSegment,
  EditingScheme,
  GeneratedClip,
  SourceVideoAsset,
  SubCut,
} from '../types/editor';

const DEMO_HOOK_LINES = [
  'SUMMER ROADTRIP ENERGY',
  'WAIT FOR THE WATERFALL DROP',
  'COASTAL GOLDEN HOUR RUN',
  'THE SECRET TO PERFECT PACING',
];

function buildSubCutsForRange(
  start: number,
  end: number,
  source: SourceVideoAsset,
  scheme: EditingScheme,
  clipIndex: number
): SubCut[] {
  const clipDur = Math.max(1, end - start);
  const asl = Math.max(0.8, Math.min(clipDur, scheme.targetAvgShotLength || 2.2));
  const subCuts: SubCut[] = [];
  let cursor = start;
  let timelineCursor = 0;
  let cutIdx = 0;

  while (cursor < end - 0.35) {
    const hookFactor =
      cutIdx < 2 &&
      (scheme.pacingProfile === 'hyper-fast' || scheme.pacingProfile === 'fast-social')
        ? 0.76
        : 1.0;
    let targetNext = Math.min(end, cursor + asl * hookFactor);

    if (scheme.beatSyncCuts && source.audioPeakTimestamps.length > 0) {
      const nearbyBeat = source.audioPeakTimestamps.find(
        (b) => b > cursor + 0.65 && Math.abs(b - targetNext) < 0.75 && b < end - 0.3
      );
      if (nearbyBeat !== undefined) {
        targetNext = nearbyBeat;
      }
    }

    if (end - targetNext < 0.7) {
      targetNext = end;
    }

    const sliceDur = Number((targetNext - cursor).toFixed(2));
    const isEmphasisCut = cutIdx % 2 === 1;
    const zoom = isEmphasisCut ? Number(scheme.punchInZoom.toFixed(2)) : 1.0;

    subCuts.push({
      id: `cut-${clipIndex + 1}-${cutIdx + 1}-${Date.now()}`,
      index: cutIdx + 1,
      sourceStart: Number(cursor.toFixed(2)),
      sourceEnd: Number(targetNext.toFixed(2)),
      timelineStart: Number(timelineCursor.toFixed(2)),
      timelineEnd: Number((timelineCursor + sliceDur).toFixed(2)),
      label: cutIdx === 0 ? 'Hook Cut' : isEmphasisCut ? 'Punch-In Cut' : `Cut #${cutIdx + 1}`,
      zoom,
      cropBiasX: 0,
      isBeatCut: scheme.beatSyncCuts,
    });

    cursor = targetNext;
    timelineCursor += sliceDur;
    cutIdx++;
  }

  return subCuts;
}

/**
 * Generates candidate 9:16 social clips from a `SourceVideoAsset` using real audio energy windows,
 * real scene cut timestamps, and the active `EditingScheme`.
 * For real uploaded videos, it NEVER inserts fake demo text.
 */
export function generateClipsFromScheme(
  source: SourceVideoAsset,
  scheme: EditingScheme
): GeneratedClip[] {
  const totalDur = Math.max(2, source.duration);
  const desiredCount = Math.max(1, Math.min(8, scheme.maxClipsCount || 4));
  const targetLen = Math.min(
    totalDur,
    Math.max(
      scheme.minClipDuration || 6,
      Math.min(scheme.maxClipDuration || 60, scheme.targetClipDuration || 20)
    )
  );

  const clips: GeneratedClip[] = [];
  const windowLen = Math.min(totalDur, Math.max(4, targetLen));
  const cleanFileName = source.name.replace(/\.[^/.]+$/, '');

  // If the uploaded video has detected highEnergyWindows, anchor clips around the highest energy segments
  const energyWindows = source.highEnergyWindows || [];

  const step =
    desiredCount > 1 && totalDur > windowLen
      ? (totalDur - windowLen) / (desiredCount - 1)
      : Math.max(2, totalDur * 0.25);

  for (let i = 0; i < desiredCount; i++) {
    let start = Number(Math.min(Math.max(0, totalDur - windowLen), i * step).toFixed(2));
    if (!source.isSyntheticDemo && energyWindows[i]) {
      const center = (energyWindows[i].start + energyWindows[i].end) / 2;
      start = Number(
        Math.max(0, Math.min(totalDur - windowLen, center - windowLen / 2)).toFixed(2)
      );
    }

    let end = Number(Math.min(totalDur, start + windowLen).toFixed(2));
    if (end - start < 3) {
      start = 0;
      end = Number(totalDur.toFixed(2));
    }

    // Snap start near a detected scene cut if within 1.4s
    const nearbyScene = source.sceneCutTimestamps.find((sc) => Math.abs(sc - start) < 1.4);
    if (nearbyScene !== undefined && nearbyScene + 4 <= totalDur) {
      start = nearbyScene;
      end = Number(Math.min(totalDur, start + windowLen).toFixed(2));
    }

    const clipDur = Number((end - start).toFixed(2));
    const subCuts = buildSubCutsForRange(start, end, source, scheme, i);

    const peaksInRange = source.audioPeakTimestamps.filter((p) => p >= start && p <= end).length;
    const cutsInRange = source.sceneCutTimestamps.filter((c) => c >= start && c <= end).length;
    const rawScore =
      76 +
      Math.round(
        peaksInRange * 3.2 * scheme.audioPeakWeight +
          cutsInRange * 4.5 * scheme.visualMotionWeight +
          (i === 0 ? 7 : 0)
      );
    const viralScore = Math.max(75, Math.min(99, rawScore));

    const isDemo = Boolean(source.isSyntheticDemo);
    const clipName = isDemo
      ? `9:16 Clip #${i + 1} — ${DEMO_HOOK_LINES[i % DEMO_HOOK_LINES.length]}`
      : `9:16 Clip #${i + 1} — ${cleanFileName} (${formatSMPTETimecode(start).slice(3)}–${formatSMPTETimecode(end).slice(3)})`;

    const captionText = isDemo
      ? i === 0
        ? 'SUMMER'
        : DEMO_HOOK_LINES[i % DEMO_HOOK_LINES.length]
      : '';

    const captions: CaptionSegment[] = [];

    const hookReason = scheme.clonedFromReference
      ? `Matched "${scheme.clonedFromReference.referenceFileName}" (${scheme.targetAvgShotLength.toFixed(1)}s ASL, ${subCuts.length} cuts)`
      : `${peaksInRange} audio peaks • ${subCuts.length} cuts @ ${scheme.targetAvgShotLength.toFixed(1)}s ASL • ${scheme.trackingMode}`;

    clips.push({
      id: `clip-${i + 1}-${Date.now()}`,
      name: clipName,
      sourceVideoId: source.id,
      schemeId: scheme.id,
      schemeName: scheme.name,
      viralScore,
      hookReason,
      sourceStart: start,
      sourceEnd: end,
      duration: clipDur,
      trackingMode: scheme.trackingMode,
      trackingOffsetX: 0,
      trackingSmoothing: scheme.trackingSmoothing,
      zoomScale: scheme.punchInZoom,
      captionText,
      captionStyle: scheme.captionStyle,
      safeZoneGuide: scheme.safeZoneGuide,
      subCuts,
      captions,
      manualKeyframes: [],
    });
  }

  return clips.sort((a, b) => b.viralScore - a.viralScore);
}

/**
 * Calls `/api/ai-analyze-video` with the uploaded video's real keyframes + WAV audio snippet
 * so Gemini / Claude / OpenAI identifies real content-aware clip ranges and transcribes real captions.
 */
export async function generateClipsWithMultimodalAI(
  source: SourceVideoAsset,
  scheme: EditingScheme,
  aiSettings: AIProviderSettings
): Promise<{ clips: GeneratedClip[] | null; providerUsed?: string; error?: string }> {
  try {
    const provider = aiSettings.activeProvider;
    const resp = await fetch('/api/ai-analyze-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model: aiSettings.models[provider],
        apiKeyOverride: aiSettings.apiKeys[provider],
        fileName: source.name,
        duration: source.duration,
        scheme: {
          name: scheme.name,
          targetClipDuration: scheme.targetClipDuration,
          minClipDuration: scheme.minClipDuration,
          maxClipDuration: scheme.maxClipDuration,
          maxClipsCount: scheme.maxClipsCount,
          targetAvgShotLength: scheme.targetAvgShotLength,
          pacingProfile: scheme.pacingProfile,
          trackingMode: scheme.trackingMode,
          punchInZoom: scheme.punchInZoom,
        },
        sceneCutTimestamps: source.sceneCutTimestamps,
        audioPeakTimestamps: source.audioPeakTimestamps,
        highEnergyWindows: source.highEnergyWindows || [],
        sampledFrames: source.sampledFrames || [],
        audioSampleBase64: source.audioSampleBase64,
        audioMimeType: 'audio/wav',
      }),
    });

    const data = await resp.json();
    if (!data.liveApiUsed || !Array.isArray(data.clips) || data.clips.length === 0) {
      return { clips: null, error: data.error };
    }

    const aiClips: GeneratedClip[] = data.clips.map((c: any, idx: number) => {
      const start = Math.max(0, Math.min(source.duration - 3, Number(c.sourceStart) || 0));
      const end = Math.max(
        start + 3,
        Math.min(source.duration, Number(c.sourceEnd) || start + scheme.targetClipDuration)
      );
      const dur = Number((end - start).toFixed(2));
      const subCuts = buildSubCutsForRange(start, end, source, scheme, idx);

      const captions: CaptionSegment[] = Array.isArray(c.captions)
        ? c.captions.map((cap: any, cIdx: number) => ({
            id: `ai-cap-${idx}-${cIdx}`,
            start: Number(cap.start) || 0,
            end: Number(cap.end) || dur,
            text: String(cap.text || ''),
          }))
        : [];

      return {
        id: `ai-clip-${idx + 1}-${Date.now()}`,
        name: c.name || `9:16 Clip #${idx + 1}`,
        sourceVideoId: source.id,
        schemeId: scheme.id,
        schemeName: scheme.name,
        viralScore: Math.max(70, Math.min(99, Number(c.viralScore) || 90)),
        hookReason: c.hookReason || `Selected by ${data.providerUsed}`,
        sourceStart: Number(start.toFixed(2)),
        sourceEnd: Number(end.toFixed(2)),
        duration: dur,
        trackingMode: scheme.trackingMode,
        trackingOffsetX: 0,
        trackingSmoothing: scheme.trackingSmoothing,
        zoomScale: scheme.punchInZoom,
        captionText: c.captionText || captions[0]?.text || '',
        captionStyle: scheme.captionStyle,
        safeZoneGuide: scheme.safeZoneGuide,
        subCuts,
        captions,
        manualKeyframes: [],
      };
    });

    return { clips: aiClips, providerUsed: data.providerUsed };
  } catch (err: any) {
    return { clips: null, error: err?.message };
  }
}

export function formatSMPTETimecode(seconds: number, fps = 30): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const totalFrames = Math.floor(safe * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(safe);
  const secs = totalSeconds % 60;
  const mins = Math.floor(totalSeconds / 60) % 60;
  const hrs = Math.floor(totalSeconds / 3600);

  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hrs)};${pad(mins)};${pad(secs)};${pad(frames)}`;
}
