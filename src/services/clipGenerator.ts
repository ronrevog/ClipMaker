import {
  AIProviderSettings,
  CaptionSegment,
  ClipCreationMode,
  EditingScheme,
  GeneratedClip,
  SourceVideoAsset,
  SubCut,
} from '../types/editor';
import {
  mapSourceTranscriptToClipTimeline,
  snapRangeToTranscriptBoundaries,
} from './aiVideoEditorTools';

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
    const segDur = Math.max(0.1, Number((cut.sourceEnd - cut.sourceStart).toFixed(2)));
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

  // If the source video has a full transcript, build the compilation from complete spoken thought blocks!
  const transcript = source.transcriptSegments || [];
  if (transcript.length >= 6) {
    // Group adjacent transcript cards into complete 5–12s thought blocks
    interface ThoughtBlock {
      start: number;
      end: number;
      duration: number;
      text: string;
      score: number;
    }
    const blocks: ThoughtBlock[] = [];
    let curStart = transcript[0].start;
    let curEnd = transcript[0].end;
    let curTexts: string[] = [transcript[0].text];

    for (let i = 1; i < transcript.length; i++) {
      const seg = transcript[i];
      if (seg.start < effectiveStart || seg.end > effectiveEnd) continue;
      const gap = seg.start - curEnd;
      const span = seg.end - curStart;
      if (gap <= 0.85 && span <= 11.0) {
        curEnd = seg.end;
        curTexts.push(seg.text);
      } else {
        const dur = Number((curEnd - curStart).toFixed(2));
        if (dur >= 3.2) {
          const stats = scoreViralWindow(source, curStart, curEnd, scheme);
          blocks.push({
            start: Number(curStart.toFixed(2)),
            end: Number(curEnd.toFixed(2)),
            duration: dur,
            text: curTexts.join(' '),
            score: stats.viralScore + (/[?!]/.test(curTexts.join(' ')) ? 5 : 0),
          });
        }
        curStart = seg.start;
        curEnd = seg.end;
        curTexts = [seg.text];
      }
    }
    const lastDur = Number((curEnd - curStart).toFixed(2));
    if (lastDur >= 3.2) {
      const stats = scoreViralWindow(source, curStart, curEnd, scheme);
      blocks.push({
        start: Number(curStart.toFixed(2)),
        end: Number(curEnd.toFixed(2)),
        duration: lastDur,
        text: curTexts.join(' '),
        score: stats.viralScore,
      });
    }

    if (blocks.length >= 3) {
      const sortedByScore = [...blocks].sort((a, b) => b.score - a.score);
      const picked: ThoughtBlock[] = [];
      let acc = 0;
      const offset = clipIndex % Math.max(1, Math.min(3, sortedByScore.length));
      for (let i = offset; i < sortedByScore.length && acc < desiredLen - 1.5; i++) {
        const cand = sortedByScore[i];
        const overlaps = picked.some(
          (p) => Math.max(p.start, cand.start) < Math.min(p.end, cand.end) + 0.5
        );
        if (!overlaps) {
          picked.push(cand);
          acc += cand.duration;
        }
      }
      if (picked.length >= 2) {
        // Put highest-scoring quote first as Cold Open Hook, then chronological story order
        const hookBlock = picked[0];
        const restChrono = picked.slice(1).sort((a, b) => a.start - b.start);
        const ordered = [hookBlock, ...restChrono];
        let tlCursor = 0;
        const transcriptSubCuts: SubCut[] = ordered.map((b, idx) => {
          const tsRange = `${formatShortTimestamp(b.start)}–${formatShortTimestamp(b.end)}`;
          const role =
            idx === 0
              ? 'Cold Open Hook'
              : idx === ordered.length - 1
                ? 'Climax Payoff'
                : `Thread Quote #${idx + 1}`;
          const cut: SubCut = {
            id: `comp-tr-${clipIndex + 1}-${idx + 1}-${Date.now()}`,
            index: idx + 1,
            sourceStart: b.start,
            sourceEnd: b.end,
            timelineStart: Number(tlCursor.toFixed(2)),
            timelineEnd: Number((tlCursor + b.duration).toFixed(2)),
            label: `${role} [${tsRange}]`,
            spokenQuote: b.text,
            narrativeRole: role,
            zoom: 1.0,
            cropBiasX: 0,
            isBeatCut: false,
          };
          tlCursor += b.duration;
          return cut;
        });
        return recalculateClipTimeline(transcriptSubCuts).subCuts;
      }
    }
  }

  const shotLen = Math.max(3.5, Math.min(desiredLen / 2.2, Math.max(4.5, scheme.targetAvgShotLength || 5.0)));
  const targetShotCount = Math.max(3, Math.min(16, Math.round(desiredLen / shotLen)));

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
  const step = Math.max(1.5, Math.min(3.0, (availableSpan - shotLen) / Math.max(8, targetShotCount * 3)));

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
    const sEnd = Number(Math.min(effectiveEnd, sStart + shotLen).toFixed(2));
    const sDur = Number((sEnd - sStart).toFixed(2));
    if (sDur < 2.0) continue;

    const stats = scoreViralWindow(source, sStart, sEnd, scheme);
    let modeScore = stats.viralScore;
    if (clipIndex % 3 === 2) {
      modeScore += stats.avgMotion * 28;
    } else if (clipIndex % 3 === 0) {
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

  const nonSilent = candidates.filter((c) => !c.isSilent);
  const pool = nonSilent.length >= targetShotCount ? nonSilent : candidates;

  const selectedShots: CandidateShot[] = [];
  let accumulatedDur = 0;

  const phaseShift = totalClipsCount > 1 ? (clipIndex / totalClipsCount) * (shotLen * 0.85) : 0;
  const numZones = Math.max(3, targetShotCount);
  const zoneSpan = availableSpan / numZones;

  for (let z = 0; z < numZones && accumulatedDur < desiredLen - 0.5; z++) {
    const zStart = effectiveStart + z * zoneSpan + (z > 0 ? phaseShift * 0.35 : 0);
    const zEnd = Math.min(effectiveEnd, effectiveStart + (z + 1) * zoneSpan + phaseShift * 0.35);

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
        Math.min(effectiveEnd, chosen.start + Math.min(chosen.duration, Math.max(2.0, needed))).toFixed(2)
      );
      const actualDur = Number((trimmedEnd - chosen.start).toFixed(2));
      if (actualDur >= 2.0) {
        selectedShots.push({
          ...chosen,
          end: trimmedEnd,
          duration: actualDur,
        });
        accumulatedDur = Number((accumulatedDur + actualDur).toFixed(2));
      }
    }
  }

  let orderedShots = [...selectedShots].sort((a, b) => a.start - b.start);
  if (clipIndex % 3 === 0 && orderedShots.length > 2) {
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

  let tlCursor = 0;
  const subCuts: SubCut[] = orderedShots.map((shot, idx) => {
    const isHook = idx === 0;
    const tsRange = `${formatShortTimestamp(shot.start)}–${formatShortTimestamp(shot.end)}`;
    const roleLabel = isHook
      ? `Cold Open Hook [${tsRange}]`
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
      zoom: 1.0,
      cropBiasX: 0,
      isBeatCut: false,
    };
    tlCursor += shot.duration;
    return cut;
  });

  return recalculateClipTimeline(subCuts).subCuts;
}

/**
 * Fallback generator ONLY used if no AI key is available or for the synthetic demo video.
 * When `source.transcriptSegments` is present, snaps cuts to real spoken sentence boundaries
 * and attaches word-level karaoke captions!
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
  const transcript = source.transcriptSegments || [];

  const targetLen = Math.min(
    totalDur,
    Math.max(3, Math.min(180, scheme.targetClipDuration || 20))
  );
  const windowLen = Math.min(totalDur, Math.max(3, targetLen));

  const clips: GeneratedClip[] = [];

  if (clipMode === 'condensed-edit') {
    const editStyleLabels = [
      'Core Thesis & Climax Cutdown',
      'Chronological Story Arc',
      'Key Debate & Insights Supercut',
      'Peak Moments Compilation',
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
      const mappedCaptions = mapSourceTranscriptToClipTimeline(
        transcript,
        recalc.subCuts,
        recalc.duration
      );
      const openingQuote = mappedCaptions[0]?.text || subCuts[0]?.spokenQuote || '';

      const variantLabel = editStyleLabels[i % editStyleLabels.length];
      const clipName = openingQuote
        ? `${variantLabel}: "${openingQuote.slice(0, 36)}${openingQuote.length > 36 ? '…' : ''}"`
        : `Compilation #${i + 1} — ${variantLabel} (${recalc.duration.toFixed(0)}s)`;

      const hookReason = openingQuote
        ? `Opens on hook "${openingQuote}" • Stitches ${subCuts.length} sentence-aligned quotes across ${recalc.duration.toFixed(0)}s`
        : `Stitched ${subCuts.length} highlight quotes into ${recalc.duration.toFixed(1)}s`;

      clips.push({
        id: `clip-edit-${i + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: clipName,
        sourceVideoId: source.id,
        schemeId: scheme.id,
        schemeName: scheme.name,
        clipCreationMode: 'condensed-edit',
        viralScore: Math.max(82, 95 - i * 2),
        hookReason,
        commonThread: variantLabel,
        viralMechanics: ['Cold Open Hook', 'Sentence-Aligned Cuts', 'Narrative Payoff'],
        sourceStart: recalc.sourceStart,
        sourceEnd: recalc.sourceEnd,
        duration: recalc.duration,
        trackingMode: scheme.trackingMode,
        trackingOffsetX: 0,
        trackingSmoothing: scheme.trackingSmoothing,
        zoomScale: 1.0,
        captionText: openingQuote,
        captionStyle: scheme.captionStyle,
        safeZoneGuide: scheme.safeZoneGuide,
        subCuts: recalc.subCuts,
        captions: mappedCaptions,
        manualKeyframes: [],
      });
    }

    return clips.sort((a, b) => b.viralScore - a.viralScore);
  }

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
    // Prefer starting on real transcript sentence boundaries when available!
    for (const seg of transcript) {
      if (seg.start >= rStart && seg.start <= rEnd - windowLen) {
        candidateStarts.add(Number(seg.start.toFixed(2)));
      }
    }
    if (candidateStarts.size < desiredCount * 2) {
      for (let t = rStart; t <= rEnd - windowLen; t += slideStep) {
        candidateStarts.add(Number(t.toFixed(2)));
      }
    }

    for (const st of candidateStarts) {
      const snapped = snapRangeToTranscriptBoundaries(
        st,
        Math.min(rEnd, st + windowLen),
        source.duration,
        transcript
      );
      const stats = scoreViralWindow(source, snapped.start, snapped.end, scheme);
      candidateWindows.push({
        start: snapped.start,
        end: snapped.end,
        viralScore: stats.viralScore,
        hookStrength: stats.hookStrength,
        peakCount: stats.peakCount,
        avgMotion: stats.avgMotion,
      });
    }
  }

  candidateWindows.sort((a, b) => b.viralScore - a.viralScore);

  const chosenWindows: RankedWindow[] = [];
  const maxAllowedOverlap = windowLen * 0.25;

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

  chosenWindows.forEach((win, i) => {
    const subCuts = buildSubCutsForRange(win.start, win.end, source, scheme, i);
    const recalc = recalculateClipTimeline(subCuts);
    const mappedCaptions = mapSourceTranscriptToClipTimeline(
      transcript,
      recalc.subCuts,
      recalc.duration
    );
    const openingQuote = mappedCaptions[0]?.text || '';
    const isDemo = Boolean(source.isSyntheticDemo);
    const tsLabel = `${formatShortTimestamp(win.start)}–${formatShortTimestamp(win.end)}`;

    const clipName = isDemo
      ? `Viral Clip #${i + 1} — ${DEMO_HOOK_LINES[i % DEMO_HOOK_LINES.length]} [${tsLabel}]`
      : openingQuote
        ? `"${openingQuote.slice(0, 42)}${openingQuote.length > 42 ? '…' : ''}" [${tsLabel}]`
        : `Viral Clip #${i + 1} [${tsLabel}] (${recalc.duration.toFixed(0)}s)`;

    const captionText = isDemo
      ? i === 0
        ? 'SUMMER'
        : DEMO_HOOK_LINES[i % DEMO_HOOK_LINES.length]
      : openingQuote;

    const hookReason = openingQuote
      ? `Opens on sentence hook: "${openingQuote}" [${tsLabel}] • Complete spoken thought (${recalc.duration.toFixed(0)}s)`
      : `Continuous Viral Segment [${tsLabel}] • Hook Strength ${win.hookStrength}%`;

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
      captions: mappedCaptions,
      manualKeyframes: [],
    });
  });

  return clips.sort((a, b) => b.viralScore - a.viralScore);
}

/**
 * Stage 2 & 3 of the AI Viral Showrunner & Common-Thread Narrative Director:
 * Sends the FULL timestamped transcript + sampled keyframes + audio peak telemetry to `/api/ai-analyze-video`,
 * snaps every cut to exact spoken sentence boundaries, and automatically attaches word-level karaoke captions!
 */
export async function generateClipsWithMultimodalAI(
  source: SourceVideoAsset,
  scheme: EditingScheme,
  aiSettings: AIProviderSettings,
  options?: {
    editorialFocusPrompt?: string;
    sourceTranscript?: CaptionSegment[];
  }
): Promise<{ clips: GeneratedClip[] | null; providerUsed?: string; error?: string }> {
  try {
    const provider = aiSettings.activeProvider;
    const clipMode: ClipCreationMode = scheme.clipCreationMode || 'clip-segment';
    const desiredCount = Math.max(1, Math.min(12, scheme.maxClipsCount || 4));
    const transcript = options?.sourceTranscript || source.transcriptSegments || [];

    const resp = await fetch('/api/ai-analyze-video', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider,
        model: aiSettings.models[provider],
        apiKeyOverride: aiSettings.apiKeys[provider],
        fileName: source.name,
        duration: source.duration,
        editorialFocusPrompt: options?.editorialFocusPrompt,
        transcriptSegments: transcript.map((seg) => ({
          start: seg.start,
          end: seg.end,
          text: seg.text,
        })),
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
        audioSampleBase64: transcript.length === 0 ? source.audioSampleBase64 : undefined,
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
        Array.isArray(c.subCuts) &&
        c.subCuts.length > 0 &&
        (clipMode === 'condensed-edit' || c.subCuts.length >= 1)
      ) {
        let tlCursor = 0;
        subCuts = c.subCuts.map((sc: any, sIdx: number) => {
          const rawStart = Math.max(0, Math.min(source.duration - 1.5, Number(sc.sourceStart) || 0));
          const rawEnd = Math.max(
            rawStart + 1.5,
            Math.min(
              source.duration,
              Number(sc.sourceEnd) ||
                rawStart +
                  (clipMode === 'condensed-edit'
                    ? Math.max(4.5, scheme.targetAvgShotLength)
                    : scheme.targetClipDuration)
            )
          );
          const snapped = snapRangeToTranscriptBoundaries(
            rawStart,
            rawEnd,
            source.duration,
            transcript
          );
          const sDur = Number((snapped.end - snapped.start).toFixed(2));
          const tsRange = `${formatShortTimestamp(snapped.start)}–${formatShortTimestamp(snapped.end)}`;
          const rolePrefix = sc.narrativeRole ? `${sc.narrativeRole}: ` : '';
          const baseLabel = sc.label || `${rolePrefix}Cut #${sIdx + 1}`;
          const cleanLabel = baseLabel.includes('[') ? baseLabel : `${baseLabel} [${tsRange}]`;

          const cut: SubCut = {
            id: `ai-edit-cut-${idx + 1}-${sIdx + 1}-${Date.now()}`,
            index: sIdx + 1,
            sourceStart: snapped.start,
            sourceEnd: snapped.end,
            timelineStart: Number(tlCursor.toFixed(2)),
            timelineEnd: Number((tlCursor + sDur).toFixed(2)),
            label: cleanLabel,
            spokenQuote: sc.spokenQuote ? String(sc.spokenQuote) : undefined,
            narrativeRole: sc.narrativeRole ? String(sc.narrativeRole) : undefined,
            zoom: 1.0,
            cropBiasX: 0,
            isBeatCut: false,
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
        const rawStart = Math.max(0, Math.min(source.duration - 3, Number(c.sourceStart) || 0));
        const rawEnd = Math.max(
          rawStart + 3,
          Math.min(
            source.duration,
            Number(c.sourceEnd) && Number(c.sourceEnd) > rawStart + 3
              ? Number(c.sourceEnd)
              : rawStart + scheme.targetClipDuration
          )
        );
        const snapped = snapRangeToTranscriptBoundaries(
          rawStart,
          rawEnd,
          source.duration,
          transcript
        );
        subCuts = buildSubCutsForRange(snapped.start, snapped.end, source, scheme, idx);
      }

      const recalc = recalculateClipTimeline(subCuts);

      // Automatically slice & map the full source video's word-level transcript onto this clip's timeline!
      const mappedCaptions = mapSourceTranscriptToClipTimeline(
        transcript,
        recalc.subCuts,
        recalc.duration
      );

      const fallbackAiCaptions: CaptionSegment[] = Array.isArray(c.captions)
        ? c.captions.map((cap: any, cIdx: number) => ({
            id: `ai-cap-${idx}-${cIdx}`,
            start: Number(cap.start) || 0,
            end: Number(cap.end) || recalc.duration,
            text: String(cap.text || ''),
          }))
        : [];

      const finalCaptions = mappedCaptions.length > 0 ? mappedCaptions : fallbackAiCaptions;
      const tsRangeBadge = `${formatShortTimestamp(recalc.sourceStart)}–${formatShortTimestamp(recalc.sourceEnd)}`;
      const rawName =
        c.name ||
        (clipMode === 'condensed-edit' ? `Compilation #${idx + 1}` : `Viral Clip #${idx + 1}`);
      const enrichedName = rawName.includes('[')
        ? rawName
        : `${rawName} [${tsRangeBadge}]`;

      return {
        id: `ai-clip-${idx + 1}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`,
        name: enrichedName,
        sourceVideoId: source.id,
        schemeId: scheme.id,
        schemeName: scheme.name,
        clipCreationMode: clipMode,
        viralScore: Math.max(75, Math.min(99, Number(c.viralScore) || 92)),
        hookReason:
          c.hookReason ||
          (c.commonThread
            ? `Theme: ${c.commonThread}`
            : `Selected by ${data.providerUsed}`),
        commonThread: c.commonThread ? String(c.commonThread) : undefined,
        viralMechanics: Array.isArray(c.viralMechanics)
          ? c.viralMechanics.map((m: any) => String(m))
          : undefined,
        editorialReasoning: c.editorialReasoning ? String(c.editorialReasoning) : undefined,
        sourceStart: recalc.sourceStart,
        sourceEnd: recalc.sourceEnd,
        duration: recalc.duration,
        trackingMode: scheme.trackingMode,
        trackingOffsetX: 0,
        trackingSmoothing: scheme.trackingSmoothing,
        zoomScale: 1.0,
        captionText: c.captionText || finalCaptions[0]?.text || '',
        captionStyle: scheme.captionStyle,
        safeZoneGuide: scheme.safeZoneGuide,
        subCuts: recalc.subCuts,
        captions: finalCaptions,
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
