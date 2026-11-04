import {
  AIProviderSettings,
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

// Cache decoded AudioBuffer per source video ID so repeated silence/transcription operations are instant
const decodedAudioBufferCache = new Map<string, AudioBuffer>();

async function getDecodedAudioBuffer(
  source: SourceVideoAsset,
  videoBlob: Blob | null
): Promise<AudioBuffer | null> {
  if (decodedAudioBufferCache.has(source.id)) {
    return decodedAudioBufferCache.get(source.id)!;
  }
  try {
    let arrayBuffer: ArrayBuffer;
    if (videoBlob) {
      arrayBuffer = await videoBlob.arrayBuffer();
    } else if (source.url) {
      const resp = await fetch(source.url);
      arrayBuffer = await resp.arrayBuffer();
    } else {
      return null;
    }
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioCtx();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    await audioCtx.close();
    decodedAudioBufferCache.set(source.id, audioBuffer);
    return audioBuffer;
  } catch (err) {
    console.warn('Could not decode audio buffer for AI tool:', err);
    return null;
  }
}

/**
 * Extracts a real mono 8000 Hz 16-bit PCM WAV base64 audio track for the active clip's timeline
 * (stitching the audio across `clip.subCuts` starting from `startClipTime` for up to `maxDurationSec`).
 */
export async function extractTimelineAudioWavBase64(
  clip: GeneratedClip,
  source: SourceVideoAsset,
  videoBlob: Blob | null,
  startClipTime = 0,
  maxDurationSec = 42
): Promise<{
  wavBase64: string | null;
  startClipTime: number;
  extractedDuration: number;
}> {
  const audioBuffer = await getDecodedAudioBuffer(source, videoBlob);
  if (!audioBuffer) {
    return {
      wavBase64: source.audioSampleBase64 || null,
      startClipTime: 0,
      extractedDuration: Math.min(22, clip.duration),
    };
  }

  const targetRate = 8000;
  const srcRate = audioBuffer.sampleRate;
  const ratio = Math.max(1, Math.floor(srcRate / targetRate));
  const actualRate = Math.round(srcRate / ratio);
  const channelData = audioBuffer.getChannelData(0);

  const effectiveStart =
    clip.duration > maxDurationSec + 5 && startClipTime < clip.duration - 4
      ? Math.max(0, startClipTime)
      : 0;
  const effectiveEnd = Math.min(clip.duration, effectiveStart + maxDurationSec);

  const downsampledChunks: Float32Array[] = [];
  let totalSamples = 0;

  for (const cut of clip.subCuts) {
    if (cut.timelineEnd <= effectiveStart || cut.timelineStart >= effectiveEnd) continue;
    const overlapTlStart = Math.max(effectiveStart, cut.timelineStart);
    const overlapTlEnd = Math.min(effectiveEnd, cut.timelineEnd);
    if (overlapTlEnd <= overlapTlStart) continue;

    const srcStart = cut.sourceStart + (overlapTlStart - cut.timelineStart);
    const srcEnd = cut.sourceStart + (overlapTlEnd - cut.timelineStart);

    const startSampleIdx = Math.max(0, Math.floor(srcStart * srcRate));
    const endSampleIdx = Math.min(channelData.length, Math.floor(srcEnd * srcRate));
    const count = Math.max(0, Math.floor((endSampleIdx - startSampleIdx) / ratio));
    if (count <= 0) continue;

    const slice = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      slice[i] = channelData[startSampleIdx + i * ratio];
    }
    downsampledChunks.push(slice);
    totalSamples += count;
  }

  if (totalSamples === 0) {
    return { wavBase64: null, startClipTime: effectiveStart, extractedDuration: 0 };
  }

  const buffer = new ArrayBuffer(44 + totalSamples * 2);
  const view = new DataView(buffer);
  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + totalSamples * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, actualRate, true);
  view.setUint32(28, actualRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, totalSamples * 2, true);

  let offset = 44;
  for (const chunk of downsampledChunks) {
    for (let i = 0; i < chunk.length; i++) {
      const s = Math.max(-1, Math.min(1, chunk[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunkSize)));
  }

  return {
    wavBase64: btoa(binary),
    startClipTime: effectiveStart,
    extractedDuration: Number((totalSamples / actualRate).toFixed(2)),
  };
}

/**
 * Transcribes the real spoken audio of `clip` using Gemini 4 Argon Multimodal Audio (`/api/ai-copilot` with `mode: 'transcribe_audio'`),
 * returning true word-level karaoke `CaptionSegment[]` synced to the speakers' voices!
 */
export async function transcribeClipAudioWithAI(params: {
  clip: GeneratedClip;
  source: SourceVideoAsset;
  videoBlob: Blob | null;
  aiSettings: AIProviderSettings;
  clipPlayheadTime: number;
  onStatus?: (msg: string) => void;
}): Promise<{
  captions: CaptionSegment[];
  providerUsed: string;
  error?: string;
}> {
  const { clip, source, videoBlob, aiSettings, clipPlayheadTime, onStatus } = params;
  onStatus?.('🎙️ Decoding timeline audio track (8kHz PCM WAV)...');

  const extracted = await extractTimelineAudioWavBase64(
    clip,
    source,
    videoBlob,
    clipPlayheadTime,
    45
  );

  if (!extracted.wavBase64) {
    return {
      captions: [],
      providerUsed: 'None',
      error: 'Could not extract audio track from video.',
    };
  }

  onStatus?.(
    `🧠 Sending ${extracted.extractedDuration.toFixed(0)}s of audio (${formatShortTimestamp(extracted.startClipTime)}–${formatShortTimestamp(extracted.startClipTime + extracted.extractedDuration)}) to Gemini 4 Argon for word-level transcription...`
  );

  const provider = aiSettings.activeProvider;
  const resp = await fetch('/api/ai-copilot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      model: aiSettings.models[provider],
      apiKeyOverride: aiSettings.apiKeys[provider],
      mode: 'transcribe_audio',
      userPrompt: 'Transcribe the exact spoken dialogue into 3-5 word karaoke caption segments.',
      audioBase64: extracted.wavBase64,
      audioMimeType: 'audio/wav',
      audioStartOffset: extracted.startClipTime,
      audioDuration: extracted.extractedDuration,
      currentPlayhead: clipPlayheadTime,
      schemeName: clip.schemeName,
    }),
  });

  if (!resp.ok) {
    return {
      captions: [],
      providerUsed: 'Error',
      error: `Transcription request failed (${resp.status})`,
    };
  }

  const data = await resp.json();
  const rawSegs: Array<{ start: number; end: number; text: string }> =
    data.transcribedSegments ||
    data.operations?.find((o: any) => o.type === 'generate_word_captions')?.captionSegments ||
    [];

  if (!Array.isArray(rawSegs) || rawSegs.length === 0) {
    return {
      captions: [],
      providerUsed: data.providerUsed || 'Gemini',
      error: 'No clear speech segments detected in this audio window.',
    };
  }

  // Convert into crisp 3-5 word karaoke cards with exact word-level timings
  const wordCaptions = buildWordLevelCaptionsFromText(
    rawSegs.map((s, idx) => ({
      id: `ai-transcribed-${idx}-${Date.now()}`,
      start: Number(s.start) || extracted.startClipTime,
      end: Number(s.end) || extracted.startClipTime + 2.0,
      text: String(s.text || '').trim(),
    })),
    clip.duration,
    4,
    extracted.startClipTime
  );

  // Merge with any existing captions outside the newly transcribed window
  const winStart = extracted.startClipTime;
  const winEnd = extracted.startClipTime + extracted.extractedDuration;
  const preservedExisting = (clip.captions || []).filter(
    (c) => c.end <= winStart + 0.2 || c.start >= winEnd - 0.2
  );

  const combined = [...preservedExisting, ...wordCaptions].sort((a, b) => a.start - b.start);

  return {
    captions: combined,
    providerUsed: `${data.modelUsed || 'gemini-4-argon'} [Live Audio]`,
  };
}

/**
 * 1. AUTO-SILENCE & DEAD-AIR JUMP CUTTER (Auto-Editor style)
 * Scans the source video's waveformPeaks across the clip's subCuts,
 * identifies TRUE dead-air pauses (>= 0.85s of actual silence), and ripple-cuts them out
 * while preserving natural conversational flow (never chopping a video into 180 micro-slices!).
 */
export function stripSilenceFromClip(
  clip: GeneratedClip,
  source: SourceVideoAsset,
  silenceThreshold = 0.16,
  minKeepDuration = 2.4,
  paddingSeconds = 0.18
): {
  updatedClip: GeneratedClip;
  removedSeconds: number;
  cutsCreated: number;
} {
  const peaks = source.waveformPeaks || [];
  const totalDur = Math.max(1, source.duration);
  const numBins = peaks.length;

  const getEnergyAtTime = (t: number): number => {
    if (numBins > 0) {
      const binIdx = Math.min(numBins - 1, Math.max(0, Math.floor((t / totalDur) * numBins)));
      return peaks[binIdx] ?? 0.3;
    }
    const sec = (source.perSecondTelemetry || []).find(
      (s) => Math.abs(s.time - Math.round(t)) <= 0.6
    );
    return sec ? sec.audioEnergy : 0.35;
  };

  // Compute adaptive silence floor (bottom 25% of energy) so normal breathing between words isn't cut
  const sortedPeaks = peaks.slice().sort((a, b) => a - b);
  const p25 = sortedPeaks.length > 0 ? sortedPeaks[Math.floor(sortedPeaks.length * 0.25)] : 0.15;
  const meanEnergy =
    numBins > 0 ? peaks.reduce((acc, v) => acc + v, 0) / numBins : 0.32;
  const effectiveThreshold = Math.max(
    0.06,
    Math.min(0.28, Math.min(silenceThreshold, Math.max(p25 * 1.15, meanEnergy * 0.48)))
  );

  // Require at least 0.85s of continuous silence before making a jump-cut
  const minSilenceGap = clip.duration > 120 ? 1.1 : 0.85;
  const step = 0.15;
  const rawKeptRanges: Array<{ start: number; end: number; baseCut: SubCut }> = [];

  for (const cut of clip.subCuts) {
    let inSpeech = false;
    let segStart = cut.sourceStart;
    let silentRun = 0;

    for (let t = cut.sourceStart; t <= cut.sourceEnd; t += step) {
      const e = getEnergyAtTime(t);
      const isLoud = e >= effectiveThreshold;

      if (isLoud) {
        silentRun = 0;
        if (!inSpeech) {
          inSpeech = true;
          segStart = Math.max(cut.sourceStart, Number((t - paddingSeconds).toFixed(2)));
        }
      } else if (inSpeech) {
        silentRun += step;
        if (silentRun >= minSilenceGap) {
          const segEnd = Math.min(
            cut.sourceEnd,
            Number((t - silentRun + paddingSeconds).toFixed(2))
          );
          if (segEnd - segStart >= minKeepDuration) {
            rawKeptRanges.push({ start: segStart, end: segEnd, baseCut: cut });
          }
          inSpeech = false;
          silentRun = 0;
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

  // Merge speech segments that are separated by less than minSilenceGap
  const mergedRanges: Array<{ start: number; end: number; baseCut: SubCut }> = [];
  for (const r of rawKeptRanges) {
    const prev = mergedRanges[mergedRanges.length - 1];
    if (prev && prev.baseCut.id === r.baseCut.id && r.start - prev.end < minSilenceGap) {
      prev.end = Math.max(prev.end, r.end);
    } else {
      mergedRanges.push({ ...r });
    }
  }

  // Cap at a clean, manageable number of cuts (max 36 cuts) by merging the smallest gaps if needed
  while (mergedRanges.length > 36) {
    let smallestGapIdx = 0;
    let smallestGap = Infinity;
    for (let i = 0; i < mergedRanges.length - 1; i++) {
      const gap = mergedRanges[i + 1].start - mergedRanges[i].end;
      if (gap < smallestGap && mergedRanges[i].baseCut.id === mergedRanges[i + 1].baseCut.id) {
        smallestGap = gap;
        smallestGapIdx = i;
      }
    }
    if (smallestGap === Infinity) break;
    mergedRanges[smallestGapIdx].end = mergedRanges[smallestGapIdx + 1].end;
    mergedRanges.splice(smallestGapIdx + 1, 1);
  }

  if (mergedRanges.length === 0) {
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
 * Adapts minimum beat interval to clip length so long videos aren't chopped into hundreds of micro-cuts.
 */
export function snapCutsToAudioBeats(
  clip: GeneratedClip,
  source: SourceVideoAsset,
  minBeatInterval?: number
): {
  updatedClip: GeneratedClip;
  beatCutsCount: number;
} {
  // Adaptive interval: ~2.4s for short clips, up to ~8s for multi-minute full videos (max ~32 cuts)
  const effectiveInterval =
    minBeatInterval ?? Math.max(2.2, Math.min(10.0, clip.duration / 24));
  const newCuts: SubCut[] = [];
  const peaks = (source.audioPeakTimestamps || []).slice().sort((a, b) => a - b);

  for (const cut of clip.subCuts) {
    const cutPeaks = peaks.filter(
      (p) => p > cut.sourceStart + effectiveInterval && p < cut.sourceEnd - 1.2
    );

    if (cutPeaks.length === 0) {
      if (cut.sourceEnd - cut.sourceStart >= effectiveInterval * 2) {
        let cur = cut.sourceStart;
        while (cur < cut.sourceEnd - 1.0) {
          const endT = Number(Math.min(cut.sourceEnd, cur + effectiveInterval).toFixed(2));
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
      if (pk - cursor >= effectiveInterval && cut.sourceEnd - pk >= 1.2) {
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
    if (cut.sourceEnd - cursor >= 0.8) {
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
 * Works on BOTH 16:9 horizontal videos AND 9:16 vertical 2-speaker videos (like IMG_0606.MOV)!
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

  // 'auto-switch': Ensure timeline has conversational cuts and alternate camera between Left Speaker and Right Speaker.
  // If source video is already 9:16 vertical (width < height), we MUST zoom in (e.g. 1.65x) so the single-speaker cut frames one speaker at a time!
  let workingClip = clip;
  if (workingClip.subCuts.length < 2) {
    workingClip = snapCutsToAudioBeats(workingClip, source, Math.max(3.0, clip.duration / 18)).updatedClip;
  }

  const isVerticalSource = (source.width || 1920) < (source.height || 1080);
  const singleSpeakerZoom = isVerticalSource
    ? Math.max(1.6, workingClip.zoomScale)
    : Math.max(1.12, workingClip.zoomScale);

  const switchedSubCuts: SubCut[] = workingClip.subCuts.map((cut, idx) => {
    const midTime = (cut.sourceStart + cut.sourceEnd) / 2;
    const sample = getTrackingStateAtTime(source.trackingSamples || [], midTime, 0, []);
    const leftTargetX =
      sample.leftSubjectX !== undefined && sample.leftSubjectX < 0.44
        ? sample.leftSubjectX
        : 0.27;
    const rightTargetX =
      sample.rightSubjectX !== undefined && sample.rightSubjectX > 0.56
        ? sample.rightSubjectX
        : 0.73;

    const isLeftSpeaker = idx % 2 === 0;
    const rawBias = (isLeftSpeaker ? leftTargetX : rightTargetX) - sample.cropX;
    const bias = Number(Math.max(-0.34, Math.min(0.34, rawBias)).toFixed(2));
    const speakerTag = isLeftSpeaker ? 'Speaker A (Left)' : 'Speaker B (Right)';

    return {
      ...cut,
      zoom: singleSpeakerZoom,
      cropBiasX: bias,
      label: `${speakerTag} [${formatShortTimestamp(cut.sourceStart)}–${formatShortTimestamp(cut.sourceEnd)}]`,
    };
  });

  return {
    ...workingClip,
    zoomScale: singleSpeakerZoom,
    backgroundFillStyle: 'blurred',
    subCuts: switchedSubCuts,
  };
}

/**
 * 4. WORD-LEVEL KARAOKE CAPTION BUILDER
 * Splits any CaptionSegment[] or raw text into crisp 3-5 word karaoke cards (`~1.2s–2.2s` per card, ~0.32s per word).
 * NEVER stretches a few words across minutes of video!
 */
export function buildWordLevelCaptionsFromText(
  textOrSegments: string | CaptionSegment[],
  clipDuration: number,
  wordsPerCard = 4,
  startOffset = 0
): CaptionSegment[] {
  if (Array.isArray(textOrSegments) && textOrSegments.length > 0) {
    const finalCards: CaptionSegment[] = [];

    for (let idx = 0; idx < textOrSegments.length; idx++) {
      const seg = textOrSegments[idx];
      const cleanWords = (seg.text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      if (cleanWords.length === 0) continue;

      const segStart = Number.isFinite(seg.start) ? seg.start : startOffset;
      // Cap maximum duration of any single spoken phrase to a natural speaking pace (~0.42s/word)
      const maxNaturalSpan = Math.max(1.2, cleanWords.length * 0.45);
      const rawSpan =
        Number.isFinite(seg.end) && seg.end > segStart ? seg.end - segStart : cleanWords.length * 0.34;
      const effectiveSpan = Math.max(0.5, Math.min(maxNaturalSpan, rawSpan));

      // Sub-chunk into cards of `wordsPerCard` (4 words max per screen card) so karaoke text is punchy
      const subChunks: string[][] = [];
      for (let i = 0; i < cleanWords.length; i += wordsPerCard) {
        subChunks.push(cleanWords.slice(i, i + wordsPerCard));
      }

      let cursorT = segStart;
      for (let cIdx = 0; cIdx < subChunks.length; cIdx++) {
        const cw = subChunks[cIdx];
        const cardSpan = (cw.length / cleanWords.length) * effectiveSpan;
        const cardStart = Number(cursorT.toFixed(2));
        const cardEnd = Number((cursorT + cardSpan).toFixed(2));
        const wordStep = Math.max(0.12, cardSpan / Math.max(1, cw.length));

        const words: CaptionWordTiming[] = cw.map((w, wIdx) => ({
          word: w,
          start: Number((cardStart + wIdx * wordStep).toFixed(2)),
          end: Number((cardStart + (wIdx + 1) * wordStep).toFixed(2)),
        }));

        finalCards.push({
          id: `wcard-${idx}-${cIdx}-${Date.now()}`,
          start: cardStart,
          end: cardEnd,
          text: cw.join(' '),
          words,
        });
        cursorT += cardSpan;
      }
    }

    return finalCards;
  }

  const rawText = typeof textOrSegments === 'string' ? textOrSegments.trim() : '';
  if (!rawText) return [];

  const allWords = rawText.split(/\s+/).filter(Boolean);
  if (allWords.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < allWords.length; i += wordsPerCard) {
    chunks.push(allWords.slice(i, i + wordsPerCard));
  }

  // Pace at natural human speech speed (~0.34s per word), starting at startOffset
  let cursor = Math.max(0, Math.min(Math.max(0, clipDuration - 1), startOffset));
  return chunks.map((chunkWords, cIdx) => {
    const cardDur = Math.max(0.9, chunkWords.length * 0.34);
    const start = Number(cursor.toFixed(2));
    const end = Number(Math.min(clipDuration, cursor + cardDur).toFixed(2));
    const wordDur = Math.max(0.15, (end - start) / Math.max(1, chunkWords.length));
    cursor = end + 0.06;

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
 * - 2-Speaker Top/Bottom 9:16 Podcast Split-Screen (`backgroundFillStyle === 'split-screen'`) — works on both 16:9 and 9:16 2-speaker videos!
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

    // Ensure Left Speaker and Right Speaker are cleanly separated in the left & right halves of the source frame
    const leftX =
      leftSubjectX !== undefined && leftSubjectX < 0.44 ? leftSubjectX : 0.27;
    const rightX =
      rightSubjectX !== undefined && rightSubjectX > 0.56 ? rightSubjectX : 0.73;

    // On vertical 2-speaker videos (like IMG_0606.MOV 720x1280), speakers sit in the upper-middle band (y ~ 0.42) above the table
    const speakerCenterY = vw < vh ? Math.min(0.43, Math.max(0.32, cropY)) : cropY;

    const drawSpeakerPanel = (
      centerX: number,
      centerY: number,
      destY: number,
      destH: number,
      badgeText: string
    ) => {
      // Each speaker panel crops ~48% of the horizontal width so only ONE speaker fills each half
      const widthFraction = vw < vh ? 0.52 : 0.46;
      const sw = Math.max(64, Math.min(vw, (vw * widthFraction) / Math.max(1.0, zoom)));
      const sh = Math.max(64, Math.min(vh, sw / panelAspect));
      const sx = Math.max(0, Math.min(vw - sw, centerX * vw - sw / 2));
      const sy = Math.max(0, Math.min(vh - sh, centerY * vh - sh / 2));
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, destY, outW, destH);

      // Subtle speaker label pill in corner
      ctx.save();
      ctx.font = `700 ${Math.max(10, Math.round(outW * 0.028))}px Inter, sans-serif`;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.72)';
      ctx.fillRect(8, destY + 8, Math.round(outW * 0.24), Math.round(outW * 0.055));
      ctx.fillStyle = '#93c5fd';
      ctx.fillText(badgeText, 14, destY + 8 + Math.round(outW * 0.04));
      ctx.restore();
    };

    // Top Panel: Speaker A (Left)
    drawSpeakerPanel(leftX, speakerCenterY, 0, halfH, 'SPEAKER A');
    // Bottom Panel: Speaker B (Right)
    drawSpeakerPanel(rightX, speakerCenterY, halfH, outH - halfH, 'SPEAKER B');

    // Clean divider line between Top & Bottom speaker panels
    ctx.save();
    ctx.fillStyle = '#0f172a';
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

    // When zoomed out (< 1.0x), fit the frame with Blurred 9:16 Background Fill or Black Bars
    if (cropAspect > canvasAspect + 0.01 || zoom < 0.99) {
      if (cropAspect > canvasAspect + 0.01) {
        dw = outW;
        dh = Math.round(outWidthToHeight(outW, cropAspect));
        dx = 0;
        dy = Math.round((outH - dh) / 2);
      } else {
        // Source is already 9:16 vertical and user zoomed out (< 1.0x): scale down over blurred background
        const scaleFactor = Math.max(0.56, Math.min(1.0, zoom));
        dw = Math.round(outW * scaleFactor);
        dh = Math.round(outH * scaleFactor);
        dx = Math.round((outW - dw) / 2);
        dy = Math.round((outH - dh) / 2);
      }

      if (backgroundFillStyle !== 'black') {
        const bgCrop = computeDistortionFree9x16Crop(vw, vh, cropX, cropY, 1.12);
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
    (c) => clipPlayheadTime >= c.start - 0.05 && clipPlayheadTime <= c.end + 0.05
  );
  // Only fall back to static clip.captionText if clip.captions is completely empty
  const text = (seg ? seg.text : clip.captions.length === 0 ? clip.captionText : '').trim();
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

  const rawWords = text.split(/\s+/).filter(Boolean);
  const segStart = seg ? seg.start : 0;
  const segEnd = seg ? seg.end : Math.min(clip.duration, segStart + Math.max(1.2, rawWords.length * 0.35));
  const wordDur = Math.max(0.12, (segEnd - segStart) / Math.max(1, rawWords.length));

  const wordsWithTiming: CaptionWordTiming[] =
    seg?.words && seg.words.length === rawWords.length
      ? seg.words
      : rawWords.map((w, idx) => ({
          word: w,
          start: segStart + idx * wordDur,
          end: segStart + (idx + 1) * wordDur,
        }));

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

  lines.forEach((ln, lineIdx) => {
    const lineW = ln.reduce((acc, w, i) => acc + w.width + (i > 0 ? spaceW : 0), 0);
    let cursorX = outW / 2 - lineW / 2;
    const lineY = startY + lineIdx * lineHeight;

    for (const mw of ln) {
      if (mw.isActive) {
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
