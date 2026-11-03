import {
  AIProviderSettings,
  CaptionSegment,
  ClipCreationMode,
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

export function formatShortTimestamp(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, '0')}`;
}

/**
 * Recomputes contiguous `timelineStart` and `timelineEnd` values (0 .. clip.duration)
 * across all `subCuts` in a clip so the elected clip's timeline is always 100% contiguous.
 */
export function recalculateClipTimeline(subCuts: SubCut[]): {
  subCuts: SubCut[];
  duration: number;
  sourceStart: number;
  sourceEnd: number;
} {
  let tlCursor = 0;
  const normalized = subCuts.map((cut, idx) => {
    const segDur = Math.max(0.25, Number((cut.sourceEnd - cut.sourceStart).toFixed(2)));
    const tlStart = Number(tlCursor.toFixed(2));
    const tlEnd = Number((tlCursor + segDur).toFixed(2));
    tlCursor = tlEnd;
    return {
      ...cut,
      index: idx + 1,
      timelineStart: tlStart,
      timelineEnd: tlEnd,
    };
  });

  const firstStart = normalized[0]?.sourceStart ?? 0;
  const lastEnd = normalized[normalized.length - 1]?.sourceEnd ?? firstStart;

  return {
    subCuts: normalized,
    duration: Number(tlCursor.toFixed(2)),
    sourceStart: firstStart,
    sourceEnd: lastEnd,
  };
}

/**
 * Converts a position on the elected clip's timeline (`0 .. clip.duration`)
 * into the exact timestamp in the underlying source video, plus the active `SubCut`.
 */
export function clipTimeToSourceTime(
  clip: GeneratedClip,
  clipTime: number
): { sourceTime: number; activeCut: SubCut | undefined; cutIndex: number } {
  const clampedClipTime = Math.max(0, Math.min(clip.duration, clipTime));
  if (!clip.subCuts || clip.subCuts.length === 0) {
    return {
      sourceTime: Number((clip.sourceStart + clampedClipTime).toFixed(3)),
      activeCut: undefined,
      cutIndex: -1,
    };
  }

  for (let i = 0; i < clip.subCuts.length; i++) {
    const cut = clip.subCuts[i];
    const isLast = i === clip.subCuts.length - 1;
    if (
      (clampedClipTime >= cut.timelineStart && clampedClipTime < cut.timelineEnd) ||
      (isLast && clampedClipTime <= cut.timelineEnd + 0.05)
    ) {
      const offsetInCut = Math.max(
        0,
        Math.min(cut.sourceEnd - cut.sourceStart, clampedClipTime - cut.timelineStart)
      );
      return {
        sourceTime: Number((cut.sourceStart + offsetInCut).toFixed(3)),
        activeCut: cut,
        cutIndex: i,
      };
    }
  }

  const lastCut = clip.subCuts[clip.subCuts.length - 1];
  return {
    sourceTime: lastCut.sourceEnd,
    activeCut: lastCut,
    cutIndex: clip.subCuts.length - 1,
  };
}

/**
 * Converts a source video timestamp into its corresponding position on the elected clip's timeline (`0 .. clip.duration`).
 */
export function sourceTimeToClipTime(clip: GeneratedClip, sourceTime: number): number {
  if (!clip.subCuts || clip.subCuts.length === 0) {
    return Math.max(0, Math.min(clip.duration, sourceTime - clip.sourceStart));
  }

  for (const cut of clip.subCuts) {
    if (sourceTime >= cut.sourceStart - 0.05 && sourceTime <= cut.sourceEnd + 0.05) {
      const offset = Math.max(
        0,
        Math.min(cut.sourceEnd - cut.sourceStart, sourceTime - cut.sourceStart)
      );
      return Number((cut.timelineStart + offset).toFixed(3));
    }
  }

  let bestCut = clip.subCuts[0];
  let bestDist = Infinity;
  for (const cut of clip.subCuts) {
    const d = Math.min(
      Math.abs(sourceTime - cut.sourceStart),
      Math.abs(sourceTime - cut.sourceEnd)
    );
    if (d < bestDist) {
      bestDist = d;
      bestCut = cut;
    }
  }
  if (sourceTime <= bestCut.sourceStart) return bestCut.timelineStart;
  return bestCut.timelineEnd;
}

/**
 * Scores a continuous window `[start, end]` for viral potential using real per-second audio energy,
 * opening hook energy (first 3 seconds), visual motion, and silence penalties.
 */
function scoreViralWindow(
  source: SourceVideoAsset,
  start: number,
  end: number,
  scheme: EditingScheme
): {
  viralScore: number;
  hookStrength: number;
  avgAudio: number;
  avgMotion: number;
  peakCount: number;
  silentSeconds: number;
} {
  const telemetry = source.perSecondTelemetry || [];
  const winSecs = telemetry.filter((t) => t.time >= Math.floor(start) && t.time <= Math.ceil(end));
  const hookSecs = telemetry.filter(
    (t) => t.time >= Math.floor(start) && t.time <= Math.floor(start) + 3
  );

  const avgAudio =
    winSecs.length > 0
      ? winSecs.reduce((acc, s) => acc + s.audioEnergy, 0) / winSecs.length
      : 0.45;
  const avgMotion =
    winSecs.length > 0
      ? winSecs.reduce((acc, s) => acc + s.motionEnergy, 0) / winSecs.length
      : 0.4;
  const hookAudio =
    hookSecs.length > 0
      ? hookSecs.reduce((acc, s) => acc + s.audioEnergy, 0) / hookSecs.length
      : avgAudio;
  const hookMotion =
    hookSecs.length > 0
      ? hookSecs.reduce((acc, s) => acc + s.motionEnergy, 0) / hookSecs.length
      : avgMotion;

  const silentSeconds = winSecs.filter((s) => s.isSilent).length;
  const peakCount = source.audioPeakTimestamps.filter((p) => p >= start && p <= end).length;
  const hookStrength = Math.min(100, Math.round((hookAudio * 60 + hookMotion * 40) * 1.25));

  const raw =
    66 +
    hookStrength * 0.16 +
    avgAudio * 22 * (scheme.audioPeakWeight || 0.8) +
    avgMotion * 16 * (scheme.visualMotionWeight || 0.7) +
    Math.min(10, peakCount * 1.4) -
    silentSeconds * 2.5;

  return {
    viralScore: Math.max(68, Math.min(99, Math.round(raw))),
    hookStrength,
    avgAudio,
    avgMotion,
    peakCount,
    silentSeconds,
  };
}

/**
 * Mode 1 ('clip-segment' — Find Best Viral Clips):
 * Creates a clean, continuous viral clip from `start` to `end` WITHOUT chopping it into artificial 2-second pieces.
 * The user can still use the Razor tool (`C`) on the timeline if they want manual splits.
 */
export function buildSubCutsForRange(
  start: number,
  end: number,
  _source: SourceVideoAsset,
  _scheme: EditingScheme,
  clipIndex: number
): SubCut[] {
  const sStart = Number(Math.max(0, start).toFixed(2));
  const sEnd = Number(Math.max(sStart + 0.5, end).toFixed(2));
  const clipDur = Number((sEnd - sStart).toFixed(2));

  return [
    {
      id: `viral-seg-${clipIndex + 1}-${Date.now()}`,
      index: 1,
      sourceStart: sStart,
      sourceEnd: sEnd,
      timelineStart: 0,
      timelineEnd: clipDur,
      label: `Viral Clip [${formatShortTimestamp(sStart)}–${formatShortTimestamp(sEnd)}]`,
      zoom: 1.0,
      cropBiasX: 0,
      isBeatCut: false,
    },
  ];
}

/**
 * Mode 2 ('condensed-edit' — Create Compilation Cutdowns):
 * Ranks distinct high-energy/high-motion/speech shots across the video, strips out dead air / low-energy filler,
 * and stitches the best non-contiguous moments together into the determined target length (`targetDuration`).
 * Each compilation variation uses a distinct editorial structure:
 * - Variant 0: Hook-First Viral Cutdown (strongest hook shot first, then chronological highlights)
 * - Variant 1: Chronological Story Cutdown (best highlights from beginning -> middle -> climax)
 * - Variant 2: Fast Action & Motion Montage (highest visual motion + beat peaks)
 * - Variant 3+: Alternating Peak & Reaction Cutdowns
 */
export function buildCondensedEditSubCuts(
  targetDuration: number,
  source: SourceVideoAsset,
  scheme: EditingScheme,
  clipIndex: number,
  totalClipsCount: number,
  rangeStart = 0,
  rangeEnd?: number
): SubCut[] {
  const effectiveStart = Math.max(0, rangeStart);
  const effectiveEnd = Math.min(
    source.duration,
    rangeEnd !== undefined && rangeEnd > effectiveStart + 2 ? rangeEnd : source.duration
  );
  const availableSpan = Math.max(2, effectiveEnd - effectiveStart);
  const desiredLen = Math.min(availableSpan, Math.max(3, targetDuration));

  const shotLen = Math.max(1.2, Math.min(desiredLen / 2.2, scheme.targetAvgShotLength || 2.5));
  const targetShotCount = Math.max(3, Math.min(40, Math.round(desiredLen / shotLen)));

  // Build candidate highlight shots across [effectiveStart, effectiveEnd]
  interface CandidateShot {
    start: number;
    end: number;
    duration: number;
    score: number;
    audioScore: number;
    motionScore: number;
    isSilent: boolean;
  }

  const candidates: CandidateShot[] = [];
  const step = Math.max(0.8, Math.min(2.0, (availableSpan - shotLen) / Math.max(8, targetShotCount * 3)));

  // Gather candidate anchor points from real audio peaks, scene cuts, and sliding steps
  const anchorPoints = new Set<number>();
  for (let t = effectiveStart; t <= effectiveEnd - shotLen; t += step) {
    anchorPoints.add(Number(t.toFixed(2)));
  }
  for (const sc of source.sceneCutTimestamps) {
    if (sc >= effectiveStart && sc <= effectiveEnd - shotLen) {
      anchorPoints.add(Number(sc.toFixed(2)));
    }
  }
  for (const pk of source.audioPeakTimestamps) {
    const prePeak = Math.max(effectiveStart, pk - 0.25);
    if (prePeak <= effectiveEnd - shotLen) {
      anchorPoints.add(Number(prePeak.toFixed(2)));
    }
  }

  const sortedAnchors = Array.from(anchorPoints).sort((a, b) => a - b);

  for (const sStart of sortedAnchors) {
    // Vary shot duration slightly around shotLen for natural editorial rhythm
    const sEnd = Number(Math.min(effectiveEnd, sStart + shotLen).toFixed(2));
    const sDur = Number((sEnd - sStart).toFixed(2));
    if (sDur < 0.75) continue;

    const stats = scoreViralWindow(source, sStart, sEnd, scheme);
    let modeScore = stats.viralScore;
    if (clipIndex % 3 === 2) {
      // Action montage bias
      modeScore += stats.avgMotion * 28;
    } else if (clipIndex % 3 === 0) {
      // Hook/Audio peak bias
      modeScore += stats.hookStrength * 0.25 + stats.peakCount * 4;
    }

    candidates.push({
      start: sStart,
      end: sEnd,
      duration: sDur,
      score: modeScore,
      audioScore: stats.avgAudio,
      motionScore: stats.avgMotion,
      isSilent: stats.silentSeconds >= Math.ceil(sDur * 0.75),
    });
  }

  // Filter out silent filler if enough non-silent candidates exist
  const nonSilent = candidates.filter((c) => !c.isSilent);
  const pool = nonSilent.length >= targetShotCount ? nonSilent : candidates;

  // Divide the video into zones so the compilation covers the full arc of the video while picking the highest-scoring shot in each zone
  const selectedShots: CandidateShot[] = [];
  let accumulatedDur = 0;

  // Shift zone boundaries slightly per clipIndex so each generated compilation picks different highlight moments
  const phaseShift = totalClipsCount > 1 ? (clipIndex / totalClipsCount) * (shotLen * 0.85) : 0;
  const numZones = Math.max(3, targetShotCount);
  const zoneSpan = availableSpan / numZones;

  for (let z = 0; z < numZones && accumulatedDur < desiredLen - 0.3; z++) {
    const zStart = effectiveStart + z * zoneSpan + (z > 0 ? phaseShift * 0.35 : 0);
    const zEnd = Math.min(effectiveEnd, effectiveStart + (z + 1) * zoneSpan + phaseShift * 0.35);

    // Find highest-scoring non-overlapping candidate in or near this zone
    const inZone = pool
      .filter(
        (c) =>
          c.start >= zStart - shotLen * 0.4 &&
          c.start <= zEnd &&
          !selectedShots.some((sel) => Math.max(sel.start, c.start) < Math.min(sel.end, c.end) + 0.15)
      )
      .sort((a, b) => b.score - a.score);

    const pickIdx = inZone.length > 1 ? clipIndex % Math.min(2, inZone.length) : 0;
    const chosen = inZone[pickIdx];

    if (chosen) {
      const needed = Number((desiredLen - accumulatedDur).toFixed(2));
      const trimmedEnd = Number(
        Math.min(effectiveEnd, chosen.start + Math.min(chosen.duration, Math.max(0.8, needed))).toFixed(2)
      );
      const actualDur = Number((trimmedEnd - chosen.start).toFixed(2));
      if (actualDur >= 0.6) {
        selectedShots.push({
          ...chosen,
          end: trimmedEnd,
          duration: actualDur,
        });
        accumulatedDur = Number((accumulatedDur + actualDur).toFixed(2));
      }
    }
  }

  // If we still need more duration to reach `desiredLen`, greedily add top remaining non-overlapping shots
  const remainingSorted = [...pool].sort((a, b) => b.score - a.score);
  for (const cand of remainingSorted) {
    if (accumulatedDur >= desiredLen - 0.35) break;
    const overlaps = selectedShots.some(
      (sel) => Math.max(sel.start, cand.start) < Math.min(sel.end, cand.end) + 0.1
    );
    if (!overlaps) {
      const needed = Number((desiredLen - accumulatedDur).toFixed(2));
      const trimmedEnd = Number(
        Math.min(effectiveEnd, cand.start + Math.min(cand.duration, Math.max(0.8, needed))).toFixed(2)
      );
      const actualDur = Number((trimmedEnd - cand.start).toFixed(2));
      if (actualDur >= 0.6) {
        selectedShots.push({
          ...cand,
          end: trimmedEnd,
          duration: actualDur,
        });
        accumulatedDur = Number((accumulatedDur + actualDur).toFixed(2));
      }
    }
  }

  // Order the selected shots according to the compilation variant style
  let orderedShots = [...selectedShots].sort((a, b) => a.start - b.start);
  if (clipIndex % 3 === 0 && orderedShots.length > 2) {
    // Variant 0: Hook-First Viral Cutdown -> Put the highest-scoring climax shot FIRST as a cold open hook, then chronological!
    let bestIdx = 0;
    for (let i = 1; i < orderedShots.length; i++) {
      if (orderedShots[i].score > orderedShots[bestIdx].score) {
        bestIdx = i;
      }
    }
    if (bestIdx > 0) {
      const [hookShot] = orderedShots.splice(bestIdx, 1);
      orderedShots = [hookShot, ...orderedShots];
    }
  }

  // Convert into SubCuts with clear source timestamp badges
  let tlCursor = 0;
  const subCuts: SubCut[] = orderedShots.map((shot, idx) => {
    const isHook = idx === 0;
    const isEmphasis = idx % 2 === 1;
    const zoom = isEmphasis ? Number(Math.max(0.55, scheme.punchInZoom || 1.0).toFixed(2)) : 1.0;
    const tsRange = `${formatShortTimestamp(shot.start)}–${formatShortTimestamp(shot.end)}`;
    const roleLabel = isHook
      ? `Hook [${tsRange}]`
      : idx === orderedShots.length - 1
        ? `Payoff [${tsRange}]`
        : `Shot #${idx + 1} [${tsRange}]`;

    const cut: SubCut = {
      id: `comp-cut-${clipIndex + 1}-${idx + 1}-${Date.now()}`,
      index: idx + 1,
      sourceStart: shot.start,
      sourceEnd: shot.end,
      timelineStart: Number(tlCursor.toFixed(2)),
      timelineEnd: Number((tlCursor + shot.duration).toFixed(2)),
      label: roleLabel,
      zoom,
      cropBiasX: 0,
      isBeatCut: scheme.beatSyncCuts,
    };
    tlCursor += shot.duration;
    return cut;
  });

  return recalculateClipTimeline(subCuts).subCuts;
}

/**
 * Generates either:
 * 1. **Best Possible Viral Clips (`'clip-segment'`)**: Top $N$ non-overlapping continuous viral segments
 *    scored by hook strength, audio/speech peaks, visual motion, and minimal dead air.
 * 2. **Compilation Cutdowns (`'condensed-edit'`)**: Top $N$ multi-shot highlight compilations stitched
 *    together into `targetClipDuration` (`5s`–`180s`) with silent/low-energy dead air stripped out.
 */
export function generateClipsFromScheme(
  source: SourceVideoAsset,
  scheme: EditingScheme,
  customRangeStart?: number,
  customRangeEnd?: number
): GeneratedClip[] {
  const rStart = customRangeStart !== undefined ? Math.max(0, customRangeStart) : 0;
  const rEnd =
    customRangeEnd !== undefined && customRangeEnd > rStart + 2
      ? Math.min(source.duration, customRangeEnd)
      : source.duration;

  const totalDur = Math.max(2, rEnd - rStart);
  const desiredCount = Math.max(1, Math.min(12, scheme.maxClipsCount || 4));
  const clipMode: ClipCreationMode = scheme.clipCreationMode || 'clip-segment';

  const targetLen = Math.min(
    totalDur,
    Math.max(3, Math.min(180, scheme.targetClipDuration || 20))
  );
  const windowLen = Math.min(totalDur, Math.max(3, targetLen));

  const clips: GeneratedClip[] = [];

  if (clipMode === 'condensed-edit') {
    // MODE B: CREATE COMPILATION CUTDOWNS
    const editStyleLabels = [
      'Hook-First Viral Compilation',
      'Chronological Story Cutdown',
      'High-Action Motion Montage',
      'Peak Audio & Speech Cutdown',
      'Fast Social Highlight Reel',
      'Tight Beat-Synced Cutdown',
    ];

    for (let i = 0; i < desiredCount; i++) {
      const subCuts = buildCondensedEditSubCuts(
        windowLen,
        source,
        scheme,
        i,
        desiredCount,
        rStart,
        rEnd
      );
      const recalc = recalculateClipTimeline(subCuts);

      const peaksInCuts = subCuts.reduce((acc, cut) => {
        return (
          acc +
          source.audioPeakTimestamps.filter((p) => p >= cut.sourceStart && p <= cut.sourceEnd).length
        );
      }, 0);

      const skippedDeadAir = Math.max(0, Number((totalDur - recalc.duration).toFixed(1)));
      const rawScore =
        84 +
        Math.round(
          peaksInCuts * 2.2 * (scheme.audioPeakWeight || 0.8) +
            subCuts.length * 1.8 * (scheme.visualMotionWeight || 0.7) +
            (i === 0 ? 5 : 0)
        );
      const viralScore = Math.max(78, Math.min(99, rawScore - i * 2));

      const variantLabel = editStyleLabels[i % editStyleLabels.length];
      const clipName = `Compilation #${i + 1} — ${variantLabel} (${recalc.duration.toFixed(0)}s • ${subCuts.length} Cuts)`;
      const hookReason = `Stitched ${subCuts.length} high-energy shots into ${recalc.duration.toFixed(1)}s • Cut ${skippedDeadAir}s of filler • ${peaksInCuts} audio peaks`;

      clips.push({
        id: `clip-edit-${i + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: clipName,
        sourceVideoId: source.id,
        schemeId: scheme.id,
        schemeName: scheme.name,
        clipCreationMode: 'condensed-edit',
        viralScore,
        hookReason,
        sourceStart: recalc.sourceStart,
        sourceEnd: recalc.sourceEnd,
        duration: recalc.duration,
        trackingMode: scheme.trackingMode,
        trackingOffsetX: 0,
        trackingSmoothing: scheme.trackingSmoothing,
        zoomScale: scheme.punchInZoom,
        captionText: '',
        captionStyle: scheme.captionStyle,
        safeZoneGuide: scheme.safeZoneGuide,
        subCuts: recalc.subCuts,
        captions: [],
        manualKeyframes: [],
      });
    }

    return clips.sort((a, b) => b.viralScore - a.viralScore);
  }

  // MODE A: FIND BEST POSSIBLE VIRAL CLIPS ('clip-segment')
  // Slide a window of `windowLen` across `[rStart, rEnd]` and rank all candidate segments by real viral telemetry!
  interface RankedWindow {
    start: number;
    end: number;
    viralScore: number;
    hookStrength: number;
    peakCount: number;
    avgMotion: number;
  }

  const candidateWindows: RankedWindow[] = [];
  const slideStep = Math.max(0.5, Math.min(2.0, (totalDur - windowLen) / 40));

  if (totalDur <= windowLen + 0.5) {
    const stats = scoreViralWindow(source, rStart, rEnd, scheme);
    candidateWindows.push({
      start: Number(rStart.toFixed(2)),
      end: Number(rEnd.toFixed(2)),
      viralScore: stats.viralScore,
      hookStrength: stats.hookStrength,
      peakCount: stats.peakCount,
      avgMotion: stats.avgMotion,
    });
  } else {
    const candidateStarts = new Set<number>();
    for (let t = rStart; t <= rEnd - windowLen; t += slideStep) {
      candidateStarts.add(Number(t.toFixed(2)));
    }
    // Also align candidate starts with real scene cuts and audio peaks
    for (const sc of source.sceneCutTimestamps) {
      if (sc >= rStart && sc <= rEnd - windowLen) {
        candidateStarts.add(Number(sc.toFixed(2)));
      }
    }
    for (const pk of source.audioPeakTimestamps) {
      const pre = Math.max(rStart, pk - 0.3);
      if (pre <= rEnd - windowLen) {
        candidateStarts.add(Number(pre.toFixed(2)));
      }
    }

    for (const st of candidateStarts) {
      const en = Number(Math.min(rEnd, st + windowLen).toFixed(2));
      const stats = scoreViralWindow(source, st, en, scheme);
      candidateWindows.push({
        start: st,
        end: en,
        viralScore: stats.viralScore,
        hookStrength: stats.hookStrength,
        peakCount: stats.peakCount,
        avgMotion: stats.avgMotion,
      });
    }
  }

  candidateWindows.sort((a, b) => b.viralScore - a.viralScore);

  // Greedily pick top N non-overlapping (or minimally overlapping) viral windows
  const chosenWindows: RankedWindow[] = [];
  const maxAllowedOverlap = windowLen * 0.3;

  for (const cand of candidateWindows) {
    if (chosenWindows.length >= desiredCount) break;
    const tooClose = chosenWindows.some((existing) => {
      const overlap = Math.max(0, Math.min(existing.end, cand.end) - Math.max(existing.start, cand.start));
      return overlap > maxAllowedOverlap;
    });
    if (!tooClose) {
      chosenWindows.push(cand);
    }
  }

  // If the video is short and user requested more clips than non-overlapping windows fit, fill with remaining best shifted windows
  if (chosenWindows.length < desiredCount) {
    const evenStep =
      desiredCount > 1 && totalDur > windowLen
        ? (totalDur - windowLen) / (desiredCount - 1)
        : 0;
    for (let i = chosenWindows.length; i < desiredCount; i++) {
      const st = Number(Math.min(Math.max(rStart, rEnd - windowLen), rStart + i * evenStep).toFixed(2));
      const en = Number(Math.min(rEnd, st + windowLen).toFixed(2));
      const stats = scoreViralWindow(source, st, en, scheme);
      chosenWindows.push({
        start: st,
        end: en,
        viralScore: Math.max(72, stats.viralScore - i * 2),
        hookStrength: stats.hookStrength,
        peakCount: stats.peakCount,
        avgMotion: stats.avgMotion,
      });
    }
  }

  chosenWindows.forEach((win, i) => {
    const subCuts = buildSubCutsForRange(win.start, win.end, source, scheme, i);
    const recalc = recalculateClipTimeline(subCuts);
    const isDemo = Boolean(source.isSyntheticDemo);
    const tsLabel = `${formatShortTimestamp(win.start)}–${formatShortTimestamp(win.end)}`;

    const clipName = isDemo
      ? `Viral Clip #${i + 1} — ${DEMO_HOOK_LINES[i % DEMO_HOOK_LINES.length]} [${tsLabel}]`
      : `Viral Clip #${i + 1} [${tsLabel}] (${recalc.duration.toFixed(0)}s)`;

    const captionText = isDemo
      ? i === 0
        ? 'SUMMER'
        : DEMO_HOOK_LINES[i % DEMO_HOOK_LINES.length]
      : '';

    const hookReason = `Continuous Viral Segment [${tsLabel}] • Hook Strength ${win.hookStrength}% • ${win.peakCount} audio/speech peaks`;

    clips.push({
      id: `clip-seg-${i + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      name: clipName,
      sourceVideoId: source.id,
      schemeId: scheme.id,
      schemeName: scheme.name,
      clipCreationMode: 'clip-segment',
      viralScore: win.viralScore,
      hookReason,
      sourceStart: recalc.sourceStart,
      sourceEnd: recalc.sourceEnd,
      duration: recalc.duration,
      trackingMode: scheme.trackingMode,
      trackingOffsetX: 0,
      trackingSmoothing: scheme.trackingSmoothing,
      zoomScale: 1.0,
      captionText,
      captionStyle: scheme.captionStyle,
      safeZoneGuide: scheme.safeZoneGuide,
      subCuts: recalc.subCuts,
      captions: [],
      manualKeyframes: [],
    });
  });

  return clips.sort((a, b) => b.viralScore - a.viralScore);
}

/**
 * Calls `/api/ai-analyze-video` with the uploaded video's real keyframes + WAV audio snippet
 * so Gemini / Claude / OpenAI identifies real content-aware clip ranges or condensed edits
 * and transcribes real captions.
 */
export async function generateClipsWithMultimodalAI(
  source: SourceVideoAsset,
  scheme: EditingScheme,
  aiSettings: AIProviderSettings
): Promise<{ clips: GeneratedClip[] | null; providerUsed?: string; error?: string }> {
  try {
    const provider = aiSettings.activeProvider;
    const clipMode: ClipCreationMode = scheme.clipCreationMode || 'clip-segment';
    const desiredCount = Math.max(1, Math.min(12, scheme.maxClipsCount || 4));

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
          clipCreationMode: clipMode,
          targetClipDuration: scheme.targetClipDuration,
          minClipDuration: 5,
          maxClipDuration: 180,
          maxClipsCount: desiredCount,
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

    const aiClips: GeneratedClip[] = data.clips.slice(0, desiredCount).map((c: any, idx: number) => {
      let subCuts: SubCut[] = [];

      if (
        clipMode === 'condensed-edit' &&
        Array.isArray(c.subCuts) &&
        c.subCuts.length > 1
      ) {
        let tlCursor = 0;
        subCuts = c.subCuts.map((sc: any, sIdx: number) => {
          const sStart = Math.max(0, Math.min(source.duration - 0.5, Number(sc.sourceStart) || 0));
          const sEnd = Math.max(
            sStart + 0.5,
            Math.min(source.duration, Number(sc.sourceEnd) || sStart + scheme.targetAvgShotLength)
          );
          const sDur = Number((sEnd - sStart).toFixed(2));
          const tsRange = `${formatShortTimestamp(sStart)}–${formatShortTimestamp(sEnd)}`;
          const cut: SubCut = {
            id: `ai-edit-cut-${idx + 1}-${sIdx + 1}-${Date.now()}`,
            index: sIdx + 1,
            sourceStart: Number(sStart.toFixed(2)),
            sourceEnd: Number(sEnd.toFixed(2)),
            timelineStart: Number(tlCursor.toFixed(2)),
            timelineEnd: Number((tlCursor + sDur).toFixed(2)),
            label: sc.label ? `${sc.label} [${tsRange}]` : `Shot #${sIdx + 1} [${tsRange}]`,
            zoom: sIdx % 2 === 1 ? scheme.punchInZoom : 1.0,
            cropBiasX: 0,
            isBeatCut: scheme.beatSyncCuts,
          };
          tlCursor += sDur;
          return cut;
        });
      } else if (clipMode === 'condensed-edit') {
        subCuts = buildCondensedEditSubCuts(
          scheme.targetClipDuration,
          source,
          scheme,
          idx,
          desiredCount
        );
      } else {
        const start = Math.max(0, Math.min(source.duration - 3, Number(c.sourceStart) || 0));
        const end = Math.max(
          start + 3,
          Math.min(source.duration, start + scheme.targetClipDuration)
        );
        subCuts = buildSubCutsForRange(start, end, source, scheme, idx);
      }

      const recalc = recalculateClipTimeline(subCuts);

      const captions: CaptionSegment[] = Array.isArray(c.captions)
        ? c.captions.map((cap: any, cIdx: number) => ({
            id: `ai-cap-${idx}-${cIdx}`,
            start: Number(cap.start) || 0,
            end: Number(cap.end) || recalc.duration,
            text: String(cap.text || ''),
          }))
        : [];

      return {
        id: `ai-clip-${idx + 1}-${Date.now()}`,
        name:
          c.name ||
          (clipMode === 'condensed-edit' ? `Compilation #${idx + 1}` : `Viral Clip #${idx + 1}`),
        sourceVideoId: source.id,
        schemeId: scheme.id,
        schemeName: scheme.name,
        clipCreationMode: clipMode,
        viralScore: Math.max(70, Math.min(99, Number(c.viralScore) || 90)),
        hookReason: c.hookReason || `Selected by ${data.providerUsed}`,
        sourceStart: recalc.sourceStart,
        sourceEnd: recalc.sourceEnd,
        duration: recalc.duration,
        trackingMode: scheme.trackingMode,
        trackingOffsetX: 0,
        trackingSmoothing: scheme.trackingSmoothing,
        zoomScale: clipMode === 'condensed-edit' ? scheme.punchInZoom : 1.0,
        captionText: c.captionText || captions[0]?.text || '',
        captionStyle: scheme.captionStyle,
        safeZoneGuide: scheme.safeZoneGuide,
        subCuts: recalc.subCuts,
        captions,
        manualKeyframes: [],
      };
    });

    if (aiClips.length < desiredCount) {
      const fallbackClips = generateClipsFromScheme(source, scheme);
      for (let i = aiClips.length; i < desiredCount && i < fallbackClips.length; i++) {
        aiClips.push(fallbackClips[i]);
      }
    }

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
