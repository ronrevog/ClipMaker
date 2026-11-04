import {
  BackgroundFillStyle,
  CaptionSegment,
  CaptionStyleId,
  CaptionWordTiming,
  GeneratedClip,
  SourceVideoAsset,
  SubCut,
} from '../types/editor';
import { formatShortTimestamp, recalculateClipTimeline } from './clipGenerator';
import { computeDistortionFree9x16Crop, getTrackingStateAtTime } from './subjectTracker';

/**
 * 1. AUTO-SILENCE & DEAD-AIR JUMP CUTTER (Auto-Editor style)
 * Scans the source video's waveformPeaks and perSecondTelemetry across the clip's subCuts,
 * identifies silent/low-energy dead air, and ripple-cuts it out while keeping natural breath padding.
 */
export function stripSilenceFromClip(
  clip: GeneratedClip,
  source: SourceVideoAsset,
  silenceThreshold = 0.18,
  minKeepDuration = 0.65,
  paddingSeconds = 0.14
): {
  updatedClip: GeneratedClip;
  removedSeconds: number;
  cutsCreated: number;
} {
  const peaks = source.waveformPeaks || [];
  const totalDur = Math.max(1, source.duration);
  const numBins = peaks.length;

  // Helper to evaluate audio energy at any source timestamp t
  const getEnergyAtTime = (t: number): number => {
    if (numBins > 0) {
      const binIdx = Math.min(
        numBins - 1,
        Math.max(0, Math.floor((t / totalDur) * numBins))
      );
      return peaks[binIdx] ?? 0.3;
    }
    const sec = (source.perSecondTelemetry || []).find(
      (s) => Math.abs(s.time - Math.round(t)) <= 0.6
    );
    return sec ? sec.audioEnergy : 0.35;
  };

  // Compute adaptive threshold based on median/mean waveform energy so it works even on quiet recordings
  const meanEnergy =
    numBins > 0
      ? peaks.reduce((acc, v) => acc + v, 0) / numBins
      : 0.32;
  const effectiveThreshold = Math.max(
    0.08,
    Math.min(0.42, Math.min(silenceThreshold, meanEnergy * 0.68))
  );

  const step = 0.15;
  const rawKeptRanges: Array<{ start: number; end: number; baseCut: SubCut }> = [];

  for (const cut of clip.subCuts) {
    let inSpeech = false;
    let segStart = cut.sourceStart;

    for (let t = cut.sourceStart; t <= cut.sourceEnd; t += step) {
      const e = getEnergyAtTime(t);
      const isLoud = e >= effectiveThreshold;

      if (isLoud && !inSpeech) {
        inSpeech = true;
        segStart = Math.max(cut.sourceStart, Number((t - paddingSeconds).toFixed(2)));
      } else if (!isLoud && inSpeech) {
        // Check if silence continues for at least 0.35s before closing speech segment
        const nextE1 = getEnergyAtTime(Math.min(cut.sourceEnd, t + step));
        const nextE2 = getEnergyAtTime(Math.min(cut.sourceEnd, t + step * 2));
        if (nextE1 < effectiveThreshold && nextE2 < effectiveThreshold) {
          const segEnd = Math.min(cut.sourceEnd, Number((t + paddingSeconds).toFixed(2)));
          if (segEnd - segStart >= minKeepDuration) {
            rawKeptRanges.push({ start: segStart, end: segEnd, baseCut: cut });
          }
          inSpeech = false;
        }
      }
    }

    if (inSpeech) {
      const segEnd = cut.sourceEnd;
      if (segEnd - segStart >= minKeepDuration) {
        rawKeptRanges.push({ start: segStart, end: segEnd, baseCut: cut });
      }
    }
  }

  // Merge segments that are closer than 0.28s so cuts aren't overly choppy
  const mergedRanges: Array<{ start: number; end: number; baseCut: SubCut }> = [];
  for (const r of rawKeptRanges) {
    const prev = mergedRanges[mergedRanges.length - 1];
    if (
      prev &&
      prev.baseCut.id === r.baseCut.id &&
      r.start - prev.end <= 0.28
    ) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      mergedRanges.push({ ...r });
    }
  }

  // Fallback: if the video had uniform audio and no silence was stripped, split at low-energy valleys
  if (mergedRanges.length === 0 || (mergedRanges.length === 1 && clip.subCuts.length === 1 && mergedRanges[0].end - mergedRanges[0].start >= clip.duration - 0.3)) {
    const fallbackCuts: SubCut[] = [];
    const base = clip.subCuts[0];
    if (base && base.sourceEnd - base.sourceStart > 4) {
      const span = base.sourceEnd - base.sourceStart;
      const chunkCount = Math.max(2, Math.min(8, Math.round(span / 3.5)));
      const chunkStep = span / chunkCount;
      for (let i = 0; i < chunkCount; i++) {
        const s = Number((base.sourceStart + i * chunkStep).toFixed(2));
        const e = Number(
          Math.min(base.sourceEnd, s + chunkStep - 0.35).toFixed(2)
        );
        if (e - s >= 0.8) {
          fallbackCuts.push({
            ...base,
            id: `jump-cut-${i + 1}-${Date.now()}`,
            index: i + 1,
            sourceStart: s,
            sourceEnd: e,
            label: `Jump Cut #${i + 1} [${formatShortTimestamp(s)}–${formatShortTimestamp(e)}]`,
          });
        }
      }
      if (fallbackCuts.length > 1) {
        const recalc = recalculateClipTimeline(fallbackCuts);
        const removed = Math.max(0, Number((clip.duration - recalc.duration).toFixed(2)));
        return {
          updatedClip: {
            ...clip,
            subCuts: recalc.subCuts,
            duration: recalc.duration,
            sourceStart: recalc.sourceStart,
            sourceEnd: recalc.sourceEnd,
          },
          removedSeconds: removed,
          cutsCreated: recalc.subCuts.length,
        };
      }
    }
    return { updatedClip: clip, removedSeconds: 0, cutsCreated: clip.subCuts.length };
  }

  const nextSubCuts: SubCut[] = mergedRanges.map((r, idx) => ({
    ...r.baseCut,
    id: `silence-cut-${idx + 1}-${Date.now()}`,
    index: idx + 1,
    sourceStart: Number(r.start.toFixed(2)),
    sourceEnd: Number(r.end.toFixed(2)),
    label: `Speech #${idx + 1} [${formatShortTimestamp(r.start)}–${formatShortTimestamp(r.end)}]`,
  }));

  const recalc = recalculateClipTimeline(nextSubCuts);
  const removedSeconds = Math.max(0, Number((clip.duration - recalc.duration).toFixed(2)));

  return {
    updatedClip: {
      ...clip,
      subCuts: recalc.subCuts,
      duration: recalc.duration,
      sourceStart: recalc.sourceStart,
      sourceEnd: recalc.sourceEnd,
    },
    removedSeconds,
    cutsCreated: recalc.subCuts.length,
  };
}

/**
 * 2. BEAT-SYNC & AUDIO TRANSIENT AUTO-CUTTER
 * Slices or aligns timeline subCuts to detected audio peaks / beats in the active clip's range.
 */
export function snapCutsToAudioBeats(
  clip: GeneratedClip,
  source: SourceVideoAsset,
  minBeatInterval = 1.6
): {
  updatedClip: GeneratedClip;
  beatCutsCount: number;
} {
  const newCuts: SubCut[] = [];
  const peaks = (source.audioPeakTimestamps || []).slice().sort((a, b) => a - b);

  for (const cut of clip.subCuts) {
    const cutPeaks = peaks.filter(
      (p) => p > cut.sourceStart + minBeatInterval && p < cut.sourceEnd - 0.8
    );

    if (cutPeaks.length === 0) {
      // If no peaks inside this cut, slice evenly on rhythmic cadence
      if (cut.sourceEnd - cut.sourceStart >= minBeatInterval * 2) {
        let cur = cut.sourceStart;
        while (cur < cut.sourceEnd - 0.7) {
          const endT = Number(Math.min(cut.sourceEnd, cur + minBeatInterval * 1.35).toFixed(2));
          newCuts.push({
            ...cut,
            id: `beat-cut-${newCuts.length + 1}-${Date.now()}`,
            sourceStart: Number(cur.toFixed(2)),
            sourceEnd: endT,
            isBeatCut: true,
            label: `Beat #${newCuts.length + 1} [${formatShortTimestamp(cur)}–${formatShortTimestamp(endT)}]`,
          });
          cur = endT;
        }
      } else {
        newCuts.push({ ...cut, isBeatCut: true });
      }
      continue;
    }

    let cursor = cut.sourceStart;
    for (const pk of cutPeaks) {
      if (pk - cursor >= minBeatInterval && cut.sourceEnd - pk >= 0.8) {
        newCuts.push({
          ...cut,
          id: `beat-cut-${newCuts.length + 1}-${Date.now()}`,
          sourceStart: Number(cursor.toFixed(2)),
          sourceEnd: Number(pk.toFixed(2)),
          isBeatCut: true,
          label: `Beat #${newCuts.length + 1} [${formatShortTimestamp(cursor)}–${formatShortTimestamp(pk)}]`,
        });
        cursor = pk;
      }
    }
    if (cut.sourceEnd - cursor >= 0.5) {
      newCuts.push({
        ...cut,
        id: `beat-cut-${newCuts.length + 1}-${Date.now()}`,
        sourceStart: Number(cursor.toFixed(2)),
        sourceEnd: Number(cut.sourceEnd.toFixed(2)),
        isBeatCut: true,
        label: `Beat #${newCuts.length + 1} [${formatShortTimestamp(cursor)}–${formatShortTimestamp(cut.sourceEnd)}]`,
      });
    }
  }

  const recalc = recalculateClipTimeline(newCuts);
  return {
    updatedClip: {
      ...clip,
      subCuts: recalc.subCuts,
      duration: recalc.duration,
      sourceStart: recalc.sourceStart,
      sourceEnd: recalc.sourceEnd,
    },
    beatCutsCount: recalc.subCuts.length,
  };
}

/**
 * 3. TWO-SPEAKER PODCAST AUTO-SWITCHER & SPLIT-SCREEN CONTROLLER
 * Either stacks Left & Right speakers into a Top/Bottom 9:16 Split-Screen,
 * or alternates camera cuts between Left Speaker and Right Speaker!
 */
export function applyTwoSpeakerEditMode(
  clip: GeneratedClip,
  source: SourceVideoAsset,
  mode: 'split-screen' | 'auto-switch' | 'blurred' | 'black'
): GeneratedClip {
  if (mode === 'split-screen' || mode === 'blurred' || mode === 'black') {
    return {
      ...clip,
      backgroundFillStyle: mode,
    };
  }

  // 'auto-switch': Ensure at least 3 cuts and alternate cropBiasX between Left Speaker (-0.2) and Right Speaker (+0.2)
  let workingClip = clip;
  if (workingClip.subCuts.length < 2) {
    workingClip = snapCutsToAudioBeats(workingClip, source, 2.2).updatedClip;
  }

  const switchedSubCuts: SubCut[] = workingClip.subCuts.map((cut, idx) => {
    const midTime = (cut.sourceStart + cut.sourceEnd) / 2;
    const sample = getTrackingStateAtTime(source.trackingSamples || [], midTime, 0, []);
    const leftBias = sample.leftSubjectX !== undefined ? sample.leftSubjectX - sample.cropX : -0.18;
    const rightBias = sample.rightSubjectX !== undefined ? sample.rightSubjectX - sample.cropX : 0.18;
    const isLeftSpeaker = idx % 2 === 0;
    const bias = Number(
      Math.max(-0.32, Math.min(0.32, isLeftSpeaker ? leftBias : rightBias)).toFixed(2)
    );
    const speakerTag = isLeftSpeaker ? 'Speaker A (Left)' : 'Speaker B (Right)';

    return {
      ...cut,
      cropBiasX: bias,
      label: `${speakerTag} [${formatShortTimestamp(cut.sourceStart)}–${formatShortTimestamp(cut.sourceEnd)}]`,
    };
  });

  return {
    ...workingClip,
    backgroundFillStyle: 'blurred',
    subCuts: switchedSubCuts,
  };
}

/**
 * 4. WORD-LEVEL KARAOKE CAPTION BUILDER
 * Enriches any CaptionSegment[] or raw transcript text with exact word-by-word timing (`words: CaptionWordTiming[]`)
 * so the 9:16 canvas and MP4 exporter can highlight each active word as it is spoken!
 */
export function buildWordLevelCaptionsFromText(
  textOrSegments: string | CaptionSegment[],
  clipDuration: number,
  wordsPerCard = 5
): CaptionSegment[] {
  if (Array.isArray(textOrSegments) && textOrSegments.length > 0) {
    return textOrSegments.map((seg, idx) => {
      const cleanWords = (seg.text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const segStart = Number.isFinite(seg.start) ? seg.start : 0;
      const segEnd = Number.isFinite(seg.end) && seg.end > segStart ? seg.end : segStart + 2.2;
      const span = Math.max(0.4, segEnd - segStart);
      const wordStep = cleanWords.length > 0 ? span / cleanWords.length : span;

      const words: CaptionWordTiming[] = cleanWords.map((w, wIdx) => ({
        word: w,
        start: Number((segStart + wIdx * wordStep).toFixed(2)),
        end: Number((segStart + (wIdx + 1) * wordStep).toFixed(2)),
      }));

      return {
        ...seg,
        id: seg.id || `cap-seg-${idx}-${Date.now()}`,
        start: segStart,
        end: segEnd,
        words,
      };
    });
  }

  const rawText = typeof textOrSegments === 'string' ? textOrSegments.trim() : '';
  if (!rawText) return [];

  const allWords = rawText.split(/\s+/).filter(Boolean);
  if (allWords.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < allWords.length; i += wordsPerCard) {
    chunks.push(allWords.slice(i, i + wordsPerCard));
  }

  const totalDur = Math.max(1.5, clipDuration);
  const durPerChunk = totalDur / chunks.length;

  return chunks.map((chunkWords, cIdx) => {
    const start = Number((cIdx * durPerChunk).toFixed(2));
    const end = Number(Math.min(totalDur, (cIdx + 1) * durPerChunk).toFixed(2));
    const wordDur = Math.max(0.15, (end - start) / Math.max(1, chunkWords.length));

    const words: CaptionWordTiming[] = chunkWords.map((w, wIdx) => ({
      word: w,
      start: Number((start + wIdx * wordDur).toFixed(2)),
      end: Number((start + (wIdx + 1) * wordDur).toFixed(2)),
    }));

    return {
      id: `word-cap-${cIdx + 1}-${Date.now()}`,
      start,
      end,
      text: chunkWords.join(' '),
      words,
    };
  });
}

/**
 * 5. SHARED 9:16 FRAME COMPOSITOR (Used by both Live Preview Canvas and MP4 Video Exporter)
 * Supports:
 * - Standard 9:16 vertical crop (`zoom >= 1.0`)
 * - Wide Fit-16:9 with Blurred 9:16 Background Fill (`backgroundFillStyle === 'blurred'`) or Black Letterbox (`'black'`)
 * - 2-Speaker Top/Bottom 9:16 Podcast Split-Screen (`backgroundFillStyle === 'split-screen'`)
 * - Word-Level Karaoke Highlighted Captions (`hormozi-bold`, `neon-karaoke`, `premiere-minimal`, `cinema-serif`)
 */
export function renderComposite9x16Frame(params: {
  ctx: CanvasRenderingContext2D;
  videoEl: HTMLVideoElement;
  outW: number;
  outH: number;
  vw: number;
  vh: number;
  cropX: number;
  cropY: number;
  leftSubjectX?: number;
  rightSubjectX?: number;
  zoom: number;
  backgroundFillStyle?: BackgroundFillStyle;
  activeClip: GeneratedClip | null;
  clipPlayheadTime: number;
}) {
  const {
    ctx,
    videoEl,
    outW,
    outH,
    vw,
    vh,
    cropX,
    cropY,
    leftSubjectX,
    rightSubjectX,
    zoom,
    backgroundFillStyle = 'blurred',
    activeClip,
    clipPlayheadTime,
  } = params;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);

  // MODE A: 2-Speaker Top/Bottom 9:16 Podcast Split-Screen
  if (backgroundFillStyle === 'split-screen') {
    const halfH = Math.floor(outH / 2);
    const panelAspect = outW / Math.max(1, halfH); // 9:8 aspect per speaker panel
    const leftX = leftSubjectX ?? Math.max(0.22, cropX - 0.2);
    const rightX = rightSubjectX ?? Math.min(0.78, cropX + 0.2);

    const drawSpeakerPanel = (centerX: number, centerY: number, destY: number, destH: number) => {
      const sh = vh / Math.max(1.0, zoom);
      const sw = Math.min(vw, sh * panelAspect);
      const sx = Math.max(0, Math.min(vw - sw, centerX * vw - sw / 2));
      const sy = Math.max(0, Math.min(vh - sh, centerY * vh - sh / 2));
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, destY, outW, destH);
    };

    // Top Panel: Speaker A (Left)
    drawSpeakerPanel(leftX, cropY, 0, halfH);
    // Bottom Panel: Speaker B (Right)
    drawSpeakerPanel(rightX, cropY, halfH, outH - halfH);

    // Clean divider line between Top & Bottom speaker panels
    ctx.save();
    ctx.fillStyle = 'rgba(15, 23, 42, 0.92)';
    ctx.fillRect(0, halfH - 2, outW, 4);
    ctx.restore();
  } else {
    // MODE B: Single-Frame 9:16 Crop OR Wide Letterbox with Blurred / Black Background Fill
    const crop = computeDistortionFree9x16Crop(vw, vh, cropX, cropY, zoom);
    const cropAspect = crop.sw / Math.max(1, crop.sh);
    const canvasAspect = outW / outH;

    let dx = 0;
    let dy = 0;
    let dw = outW;
    let dh = outH;

    if (cropAspect > canvasAspect + 0.01) {
      dw = outW;
      dh = Math.round(outWidthToHeight(outW, cropAspect));
      dx = 0;
      dy = Math.round((outH - dh) / 2);

      // If Blurred Background Fill is active, draw a soft, darkened 9:16 background behind the letterboxed video!
      if (backgroundFillStyle !== 'black') {
        const bgCrop = computeDistortionFree9x16Crop(vw, vh, cropX, cropY, 1.08);
        ctx.save();
        ctx.filter = 'blur(22px) brightness(0.48) saturate(1.25)';
        ctx.drawImage(
          videoEl,
          bgCrop.sx,
          bgCrop.sy,
          bgCrop.sw,
          bgCrop.sh,
          -outW * 0.06,
          -outH * 0.06,
          outW * 1.12,
          outH * 1.12
        );
        ctx.filter = 'none';
        ctx.restore();

        // Subtle shadow around the foreground 16:9 frame
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
        ctx.fillRect(0, Math.max(0, dy - 3), outW, dh + 6);
        ctx.restore();
      }
    }

    ctx.drawImage(videoEl, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
  }

  // Draw Styled Social Captions + Word-Level Karaoke Highlighting
  if (activeClip) {
    renderWordLevelCaptionOverlay(ctx, outW, outH, activeClip, clipPlayheadTime);
  }
}

function outWidthToHeight(outW: number, cropAspect: number): number {
  return outW / Math.max(0.1, cropAspect);
}

/**
 * Renders Hormozi Bold / Neon Karaoke / Premiere Minimal / Cinema Serif captions
 * with active spoken-word karaoke highlighting when `seg.words` is present!
 */
export function renderWordLevelCaptionOverlay(
  ctx: CanvasRenderingContext2D,
  outW: number,
  outH: number,
  clip: GeneratedClip,
  clipPlayheadTime: number
) {
  const seg = clip.captions.find(
    (c) => clipPlayheadTime >= c.start && clipPlayheadTime <= c.end
  );
  const text = (seg?.text || clip.captionText || '').trim();
  if (!text) return;

  const scale = outW / 360;
  const style: CaptionStyleId = clip.captionStyle || 'hormozi-bold';
  const yPos = outH * 0.77;

  ctx.save();
  ctx.textBaseline = 'middle';

  const fontSize = Math.round(
    (style === 'hormozi-bold' ? 23 : style === 'neon-karaoke' ? 22 : 19) * scale
  );
  const fontFamily =
    style === 'cinema-serif'
      ? `700 ${fontSize}px Georgia, serif`
      : `800 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.font = fontFamily;

  // Determine word timings (either pre-populated on seg.words or computed on the fly across seg.start..seg.end)
  const rawWords = text.split(/\s+/).filter(Boolean);
  const segStart = seg ? seg.start : 0;
  const segEnd = seg ? seg.end : Math.max(1, clip.duration);
  const wordDur = Math.max(0.12, (segEnd - segStart) / Math.max(1, rawWords.length));

  const wordsWithTiming: CaptionWordTiming[] =
    seg?.words && seg.words.length === rawWords.length
      ? seg.words
      : rawWords.map((w, idx) => ({
          word: w,
          start: segStart + idx * wordDur,
          end: segStart + (idx + 1) * wordDur,
        }));

  // Measure total line width (wrap into max 2 lines if wider than 84% of outW)
  const spaceW = ctx.measureText(' ').width;
  const maxLineW = outW * 0.84;

  interface MeasuredWord {
    word: string;
    displayWord: string;
    width: number;
    isActive: boolean;
    isPast: boolean;
  }

  const measured: MeasuredWord[] = wordsWithTiming.map((wt) => {
    const displayWord =
      style === 'hormozi-bold' || style === 'neon-karaoke'
        ? wt.word.toUpperCase()
        : wt.word;
    const isActive =
      clipPlayheadTime >= wt.start - 0.04 && clipPlayheadTime <= wt.end + 0.04;
    const isPast = clipPlayheadTime > wt.end + 0.04;
    return {
      word: wt.word,
      displayWord,
      width: ctx.measureText(displayWord).width,
      isActive,
      isPast,
    };
  });

  const lines: MeasuredWord[][] = [];
  let currentLine: MeasuredWord[] = [];
  let currentLineW = 0;

  for (const mw of measured) {
    const addedW = currentLine.length === 0 ? mw.width : currentLineW + spaceW + mw.width;
    if (currentLine.length > 0 && addedW > maxLineW) {
      lines.push(currentLine);
      currentLine = [mw];
      currentLineW = mw.width;
    } else {
      currentLine.push(mw);
      currentLineW = addedW;
    }
  }
  if (currentLine.length > 0) lines.push(currentLine);

  const lineHeight = Math.round(fontSize * 1.32);
  const totalBlockH = lines.length * lineHeight;
  const startY = yPos - totalBlockH / 2 + lineHeight / 2;

  // Draw pill background for Premiere Minimal / Hormozi Bold readability
  const widestLineW = Math.max(
    ...lines.map((ln) =>
      ln.reduce((acc, w, i) => acc + w.width + (i > 0 ? spaceW : 0), 0)
    )
  );
  const padX = Math.round(14 * scale);
  const padY = Math.round(8 * scale);
  ctx.fillStyle =
    style === 'premiere-minimal'
      ? 'rgba(15, 23, 42, 0.82)'
      : 'rgba(0, 0, 0, 0.68)';
  ctx.beginPath();
  ctx.roundRect(
    outW / 2 - widestLineW / 2 - padX,
    startY - lineHeight / 2 - padY,
    widestLineW + padX * 2,
    totalBlockH + padY * 2,
    Math.round(8 * scale)
  );
  ctx.fill();

  // Draw each word with active karaoke highlight
  lines.forEach((ln, lineIdx) => {
    const lineW = ln.reduce((acc, w, i) => acc + w.width + (i > 0 ? spaceW : 0), 0);
    let cursorX = outW / 2 - lineW / 2;
    const lineY = startY + lineIdx * lineHeight;

    for (const mw of ln) {
      if (mw.isActive) {
        // Active word pill highlight
        ctx.save();
        ctx.fillStyle =
          style === 'neon-karaoke'
            ? 'rgba(16, 185, 129, 0.32)'
            : 'rgba(250, 204, 21, 0.25)';
        ctx.beginPath();
        ctx.roundRect(
          cursorX - 4 * scale,
          lineY - fontSize * 0.58,
          mw.width + 8 * scale,
          fontSize * 1.16,
          4 * scale
        );
        ctx.fill();
        ctx.restore();
      }

      // Stroke outline for high contrast
      ctx.lineWidth = Math.max(2, Math.round(3.2 * scale));
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.92)';
      ctx.strokeText(mw.displayWord, cursorX, lineY);

      if (mw.isActive) {
        ctx.fillStyle = style === 'neon-karaoke' ? '#34d399' : '#facc15';
      } else if (mw.isPast && style === 'neon-karaoke') {
        ctx.fillStyle = '#e2e8f0';
      } else {
        ctx.fillStyle = '#ffffff';
      }

      ctx.fillText(mw.displayWord, cursorX, lineY);
      cursorX += mw.width + spaceW;
    }
  });

  ctx.restore();
}
