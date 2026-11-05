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
import {
  compositeForegroundSubjectMaskOverText,
  evaluateCutTransitionTransform,
  getColorGradeLutCanvasFilter,
  renderLottieStickerOnCanvas,
} from './sotaStudioEngines';
import { computeDistortionFree9x16Crop, getTrackingStateAtTime } from './subjectTracker';

let _behindSubjectSnapshotCanvas: HTMLCanvasElement | null = null;
function getBehindSubjectSnapshotCanvas(w: number, h: number): HTMLCanvasElement {
  if (!_behindSubjectSnapshotCanvas) {
    _behindSubjectSnapshotCanvas = document.createElement('canvas');
  }
  if (_behindSubjectSnapshotCanvas.width !== w || _behindSubjectSnapshotCanvas.height !== h) {
    _behindSubjectSnapshotCanvas.width = w;
    _behindSubjectSnapshotCanvas.height = h;
  }
  return _behindSubjectSnapshotCanvas;
}

// Cache decoded AudioBuffer per source video ID so repeated silence/transcription operations are instant
const decodedAudioBufferCache = new Map<string, AudioBuffer>();
// Cache full source video transcript per source video ID so viral clips & compilation cutdowns reuse the transcript instantly
const sourceTranscriptCache = new Map<string, CaptionSegment[]>();

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

  const effectiveStart = Math.max(0, Math.min(Math.max(0, clip.duration - 0.5), startClipTime));
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
 * Transcribes the ENTIRE spoken audio of `clip` from 0s to `clip.duration` by chunking into
 * 40-second WAV windows and streaming each chunk's word-level karaoke captions onto the timeline
 * in real time via `onPartialCaptions`!
 */
export async function transcribeClipAudioWithAI(params: {
  clip: GeneratedClip;
  source: SourceVideoAsset;
  videoBlob: Blob | null;
  aiSettings: AIProviderSettings;
  clipPlayheadTime: number;
  onStatus?: (msg: string) => void;
  onPartialCaptions?: (captionsSoFar: CaptionSegment[], pct: number) => void;
}): Promise<{
  captions: CaptionSegment[];
  providerUsed: string;
  error?: string;
}> {
  const { clip, source, videoBlob, aiSettings, onStatus, onPartialCaptions } = params;
  onStatus?.('🎙️ Decoding full timeline audio track (8kHz PCM WAV)...');

  const chunkDuration = 40;
  const totalDur = Math.max(1, clip.duration);
  const chunkStarts: number[] = [];
  for (let t = 0; t < totalDur - 0.8; t += chunkDuration) {
    chunkStarts.push(Number(t.toFixed(2)));
  }
  if (chunkStarts.length === 0) chunkStarts.push(0);

  const totalChunks = chunkStarts.length;
  const provider = aiSettings.activeProvider;
  let allCaptions: CaptionSegment[] = [];
  let lastProviderUsed = 'gemini-4-argon [Live Audio]';

  // Process chunks in batches of 3 in parallel so multi-minute videos transcribe 3x faster
  // while streaming captions onto the video player after every batch!
  const batchSize = 3;
  for (let b = 0; b < totalChunks; b += batchSize) {
    const batchIndices = chunkStarts
      .slice(b, b + batchSize)
      .map((startSec, offset) => ({ startSec, chunkIdx: b + offset }));

    const firstStart = batchIndices[0].startSec;
    const lastEnd = Math.min(
      totalDur,
      batchIndices[batchIndices.length - 1].startSec + chunkDuration
    );
    const pct = Math.min(98, Math.round(((b + 1) / totalChunks) * 100));

    onStatus?.(
      `Transcribing audio (${batchIndices[0].chunkIdx + 1}–${batchIndices[batchIndices.length - 1].chunkIdx + 1}/${totalChunks} · ${formatShortTimestamp(firstStart)}–${formatShortTimestamp(lastEnd)})`
    );

    const batchResults = await Promise.all(
      batchIndices.map(async ({ startSec, chunkIdx }) => {
        const extracted = await extractTimelineAudioWavBase64(
          clip,
          source,
          videoBlob,
          startSec,
          chunkDuration
        );
        if (!extracted.wavBase64 || extracted.extractedDuration < 0.4) {
          return { cards: [] as CaptionSegment[], modelUsed: '' };
        }

        try {
          const resp = await fetch('/api/ai-copilot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider,
              model: aiSettings.models[provider],
              apiKeyOverride: aiSettings.apiKeys[provider],
              mode: 'transcribe_audio',
              userPrompt:
                'Transcribe the exact spoken dialogue into 3-5 word karaoke caption segments.',
              audioBase64: extracted.wavBase64,
              audioMimeType: 'audio/wav',
              audioStartOffset: extracted.startClipTime,
              audioDuration: extracted.extractedDuration,
              currentPlayhead: extracted.startClipTime,
              schemeName: clip.schemeName,
            }),
          });

          if (!resp.ok) return { cards: [] as CaptionSegment[], modelUsed: '' };
          const data = await resp.json();
          const rawSegs: Array<{ start: number; end: number; text: string }> =
            data.transcribedSegments ||
            data.operations?.find((o: any) => o.type === 'generate_word_captions')
              ?.captionSegments ||
            [];

          if (!Array.isArray(rawSegs) || rawSegs.length === 0) {
            return { cards: [] as CaptionSegment[], modelUsed: data.modelUsed || '' };
          }

          // Double-check timestamp alignment to `extracted.startClipTime`
          const firstSegStart = Number(rawSegs[0]?.start) || 0;
          const addOffset =
            extracted.startClipTime > 1.0 && firstSegStart < extracted.startClipTime - 1.0
              ? extracted.startClipTime
              : 0;

          const cards = buildWordLevelCaptionsFromText(
            rawSegs.map((s, idx) => ({
              id: `ai-transcribed-${chunkIdx}-${idx}-${Date.now()}`,
              start: Number(((Number(s.start) || 0) + addOffset).toFixed(2)),
              end: Number(((Number(s.end) || 1.8) + addOffset).toFixed(2)),
              text: String(s.text || '').trim(),
            })),
            clip.duration,
            4,
            extracted.startClipTime
          );

          return {
            cards,
            modelUsed: data.modelUsed ? `${data.modelUsed} [Live Audio]` : '',
          };
        } catch (err) {
          console.warn(`Chunk ${chunkIdx + 1} transcription error:`, err);
          return { cards: [] as CaptionSegment[], modelUsed: '' };
        }
      })
    );

    for (const r of batchResults) {
      if (r.modelUsed) lastProviderUsed = r.modelUsed;
      if (r.cards.length > 0) {
        allCaptions.push(...r.cards);
      }
    }

    if (allCaptions.length > 0) {
      allCaptions.sort((a, b) => a.start - b.start);
      // Prevent any overlapping cards across chunk boundaries
      for (let i = 0; i < allCaptions.length - 1; i++) {
        if (allCaptions[i].end > allCaptions[i + 1].start - 0.02) {
          allCaptions[i].end = Math.max(
            allCaptions[i].start + 0.25,
            Number((allCaptions[i + 1].start - 0.02).toFixed(2))
          );
        }
      }
      const completedPct = Math.min(
        100,
        Math.round(((b + batchIndices.length) / totalChunks) * 100)
      );
      onPartialCaptions?.([...allCaptions], completedPct);
    }
  }

  // If this clip is the Full Uploaded Video (`__full_source__`), cache its transcript on the source video
  if (
    allCaptions.length > 0 &&
    (clip.id === '__full_source__' ||
      (clip.subCuts.length === 1 &&
        clip.subCuts[0].sourceStart <= 0.5 &&
        Math.abs(clip.subCuts[0].sourceEnd - source.duration) <= 1.0))
  ) {
    sourceTranscriptCache.set(source.id, allCaptions);
    source.transcriptSegments = allCaptions;
  }

  if (allCaptions.length === 0) {
    return {
      captions: [],
      providerUsed: lastProviderUsed,
      error: 'No clear speech segments detected in the video audio track.',
    };
  }

  return {
    captions: allCaptions,
    providerUsed: lastProviderUsed,
  };
}

/**
 * Ensures the full uploaded source video (`0 .. source.duration`) has been transcribed into
 * timestamped spoken dialogue segments (`source.transcriptSegments`).
 * Reuses cached transcript if already transcribed during this session!
 */
export async function ensureFullSourceTranscript(params: {
  source: SourceVideoAsset;
  videoBlob: Blob | null;
  aiSettings: AIProviderSettings;
  existingFullVideoCaptions?: CaptionSegment[];
  onStatus?: (msg: string, pct: number) => void;
}): Promise<CaptionSegment[]> {
  const { source, videoBlob, aiSettings, existingFullVideoCaptions, onStatus } = params;

  if (source.transcriptSegments && source.transcriptSegments.length >= 3) {
    sourceTranscriptCache.set(source.id, source.transcriptSegments);
    return source.transcriptSegments;
  }
  const cached = sourceTranscriptCache.get(source.id);
  if (cached && cached.length >= 3) {
    source.transcriptSegments = cached;
    return cached;
  }
  if (existingFullVideoCaptions && existingFullVideoCaptions.length >= 5) {
    sourceTranscriptCache.set(source.id, existingFullVideoCaptions);
    source.transcriptSegments = existingFullVideoCaptions;
    return existingFullVideoCaptions;
  }

  // Construct a synthetic full-source clip spanning [0, source.duration] to transcribe the entire source audio
  const fullSourceClip: GeneratedClip = {
    id: '__full_source__',
    name: source.name,
    sourceVideoId: source.id,
    schemeId: 'default',
    schemeName: 'Transcript Indexer',
    viralScore: 95,
    hookReason: '',
    sourceStart: 0,
    sourceEnd: source.duration,
    duration: source.duration,
    trackingMode: 'face-speaker',
    trackingOffsetX: 0,
    trackingSmoothing: 0.8,
    zoomScale: 1.0,
    captionText: '',
    captionStyle: 'hormozi-bold',
    safeZoneGuide: 'tiktok',
    subCuts: [
      {
        id: 'full-src-cut-1',
        index: 1,
        sourceStart: 0,
        sourceEnd: source.duration,
        timelineStart: 0,
        timelineEnd: source.duration,
        label: 'Full Source Audio',
        zoom: 1.0,
        cropBiasX: 0,
      },
    ],
    captions: [],
    manualKeyframes: [],
  };

  let latestPct = 5;
  const res = await transcribeClipAudioWithAI({
    clip: fullSourceClip,
    source,
    videoBlob,
    aiSettings,
    clipPlayheadTime: 0,
    onStatus: (msg) => {
      onStatus?.(`Stage 1/3 — ${msg}`, latestPct);
    },
    onPartialCaptions: (_partial, pct) => {
      latestPct = pct;
    },
  });

  if (res.captions.length > 0) {
    sourceTranscriptCache.set(source.id, res.captions);
    source.transcriptSegments = res.captions;
  }
  return res.captions;
}

/**
 * Snaps a raw `[sourceStart, sourceEnd]` cut to clean spoken phrase boundaries in `sourceTranscript`
 * so cuts never chop a speaker mid-word or mid-phrase.
 */
export function snapRangeToTranscriptBoundaries(
  rawStart: number,
  rawEnd: number,
  sourceDuration: number,
  sourceTranscript?: CaptionSegment[]
): { start: number; end: number } {
  const clampedStart = Math.max(0, Math.min(sourceDuration - 1.5, rawStart));
  const clampedEnd = Math.max(clampedStart + 1.5, Math.min(sourceDuration, rawEnd));
  if (!sourceTranscript || sourceTranscript.length === 0) {
    return {
      start: Number(clampedStart.toFixed(2)),
      end: Number(clampedEnd.toFixed(2)),
    };
  }

  let bestStart = clampedStart;
  let bestEnd = clampedEnd;

  // Find a transcript segment whose start is within ±1.8s of rawStart, or that spans across rawStart
  const startMatch = sourceTranscript.find(
    (seg) =>
      (rawStart >= seg.start - 0.35 && rawStart <= seg.end + 0.15) ||
      Math.abs(seg.start - rawStart) <= 1.4
  );
  if (startMatch) {
    // Start slightly (0.08s) before the first word of that phrase so the opening consonant is never clipped
    bestStart = Math.max(0, Number((startMatch.start - 0.08).toFixed(2)));
  }

  // Find a transcript segment whose end is within ±2.2s of rawEnd, or that spans across rawEnd
  const endCandidates = sourceTranscript.filter(
    (seg) =>
      seg.end > bestStart + 1.5 &&
      ((rawEnd >= seg.start - 0.15 && rawEnd <= seg.end + 0.4) ||
        Math.abs(seg.end - rawEnd) <= 1.8)
  );
  if (endCandidates.length > 0) {
    const endMatch = endCandidates[endCandidates.length - 1];
    // Pad 0.12s after the final word so the speaker finishes the thought cleanly
    bestEnd = Math.min(sourceDuration, Number((endMatch.end + 0.12).toFixed(2)));
  }

  if (bestEnd <= bestStart + 1.2) {
    bestEnd = Math.min(sourceDuration, Number((bestStart + Math.max(2.0, clampedEnd - clampedStart)).toFixed(2)));
  }

  return { start: bestStart, end: bestEnd };
}

/**
 * Slices and remaps the full source video's word-level `sourceTranscript` onto a clip's `subCuts`
 * timeline (`0 .. clipDuration`), preserving exact word-by-word karaoke timings (`words`)!
 */
export function mapSourceTranscriptToClipTimeline(
  sourceTranscript: CaptionSegment[] | undefined,
  subCuts: SubCut[],
  clipDuration: number
): CaptionSegment[] {
  if (!sourceTranscript || sourceTranscript.length === 0 || subCuts.length === 0) {
    return [];
  }

  const mapped: CaptionSegment[] = [];

  for (let cIdx = 0; cIdx < subCuts.length; cIdx++) {
    const cut = subCuts[cIdx];
    const cutSrcStart = cut.sourceStart;
    const cutSrcEnd = cut.sourceEnd;
    const cutTlStart = cut.timelineStart;
    const cutTlEnd = cut.timelineEnd;

    // Find all source transcript segments overlapping this subCut
    const overlapping = sourceTranscript.filter(
      (seg) => seg.end > cutSrcStart + 0.12 && seg.start < cutSrcEnd - 0.12
    );

    for (let sIdx = 0; sIdx < overlapping.length; sIdx++) {
      const seg = overlapping[sIdx];
      const segSrcStart = Math.max(cutSrcStart, seg.start);
      const segSrcEnd = Math.min(cutSrcEnd, seg.end);
      if (segSrcEnd <= segSrcStart + 0.12) continue;

      const tlStart = Number(
        Math.max(cutTlStart, Math.min(cutTlEnd - 0.15, cutTlStart + (segSrcStart - cutSrcStart))).toFixed(2)
      );
      const tlEnd = Number(
        Math.max(tlStart + 0.2, Math.min(cutTlEnd, cutTlStart + (segSrcEnd - cutSrcStart))).toFixed(2)
      );

      let mappedWords: CaptionWordTiming[] | undefined;
      if (Array.isArray(seg.words) && seg.words.length > 0) {
        const overlappingWords = seg.words
          .filter((w) => w.end > cutSrcStart + 0.04 && w.start < cutSrcEnd - 0.04)
          .map((w) => {
            const wStart = Number(
              Math.max(tlStart, Math.min(tlEnd - 0.05, cutTlStart + (w.start - cutSrcStart))).toFixed(2)
            );
            const wEnd = Number(
              Math.max(wStart + 0.05, Math.min(tlEnd, cutTlStart + (w.end - cutSrcStart))).toFixed(2)
            );
            return {
              word: w.word,
              start: wStart,
              end: wEnd,
            };
          });
        if (overlappingWords.length > 0) {
          mappedWords = overlappingWords;
        }
      }

      const text =
        mappedWords && mappedWords.length > 0
          ? mappedWords.map((w) => w.word).join(' ')
          : seg.text;

      if (!text.trim()) continue;

      // If mappedWords weren't present on seg, synthesize word timings across [tlStart, tlEnd]
      if (!mappedWords || mappedWords.length === 0) {
        const rawWords = text.trim().split(/\s+/);
        const span = Math.max(0.25, tlEnd - tlStart);
        const step = span / rawWords.length;
        mappedWords = rawWords.map((w, wIdx) => ({
          word: w,
          start: Number((tlStart + wIdx * step).toFixed(2)),
          end: Number((tlStart + (wIdx + 1) * step).toFixed(2)),
        }));
      }

      mapped.push({
        id: `clip-cap-${cIdx}-${sIdx}-${Date.now()}`,
        start: tlStart,
        end: tlEnd,
        text,
        highlightWord: seg.highlightWord || mappedWords[mappedWords.length - 1]?.word,
        words: mappedWords,
      });
    }
  }

  // Ensure monotonic non-overlapping timestamps across the clip timeline
  mapped.sort((a, b) => a.start - b.start);
  for (let i = 0; i < mapped.length - 1; i++) {
    if (mapped[i].end > mapped[i + 1].start - 0.02) {
      mapped[i].end = Math.max(
        mapped[i].start + 0.18,
        Number((mapped[i + 1].start - 0.02).toFixed(2))
      );
    }
  }

  return mapped.filter((m) => m.start < clipDuration);
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
  const isVerticalSource = (source.width || 1920) < (source.height || 1080);
  const defaultY = isVerticalSource ? 0.39 : 0.44;
  const spkAX = clip.speakerAX ?? 0.26;
  const spkAY = clip.speakerAY ?? defaultY;
  const spkBX = clip.speakerBX ?? 0.74;
  const spkBY = clip.speakerBY ?? defaultY;

  if (mode === 'split-screen') {
    return {
      ...clip,
      backgroundFillStyle: 'split-screen',
      speakerAX: spkAX,
      speakerAY: spkAY,
      speakerBX: spkBX,
      speakerBY: spkBY,
      zoomScale: 1.0,
      subCuts: clip.subCuts.map((c) => ({ ...c, zoom: 1.0, cropBiasX: 0 })),
    };
  }

  if (mode === 'blurred' || mode === 'black') {
    return {
      ...clip,
      backgroundFillStyle: mode,
    };
  }

  // 'auto-switch': Ensure timeline has conversational cuts and alternate camera between Left Speaker (A) and Right Speaker (B).
  // On a 9:16 vertical 2-speaker source video (width < height, like 720x1280), we zoom to 1.92x so each cut frames strictly ONE speaker!
  let workingClip = clip;
  if (workingClip.subCuts.length < 2) {
    const targetInterval = Math.max(2.8, Math.min(5.0, clip.duration / 12));
    workingClip = snapCutsToAudioBeats(workingClip, source, targetInterval).updatedClip;
  }

  const singleSpeakerZoom = isVerticalSource ? 1.92 : Math.max(1.18, workingClip.zoomScale);
  const speakerAnchorY = (spkAY + spkBY) / 2;

  const switchedSubCuts: SubCut[] = workingClip.subCuts.map((cut, idx) => {
    const isLeftSpeaker = idx % 2 === 0;
    const bias = isLeftSpeaker ? spkAX - 0.5 : spkBX - 0.5;
    const speakerTag = isLeftSpeaker ? 'Speaker A (Left)' : 'Speaker B (Right)';

    return {
      ...cut,
      zoom: singleSpeakerZoom,
      cropBiasX: Number(bias.toFixed(3)),
      label: `${speakerTag} [${formatShortTimestamp(cut.sourceStart)}–${formatShortTimestamp(cut.sourceEnd)}]`,
    };
  });

  return {
    ...workingClip,
    speakerAX: spkAX,
    speakerAY: spkAY,
    speakerBX: spkBX,
    speakerBY: spkBY,
    zoomScale: singleSpeakerZoom,
    backgroundFillStyle: 'blurred',
    trackingOffsetX: 0,
    manualKeyframes: [],
    subjectFocus: {
      strategy: 'static-lock',
      anchorX: 0.5,
      anchorY: speakerAnchorY,
      anchorTime: 0,
      label: '2-Speaker Auto-Switch',
    },
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

    finalCards.sort((a, b) => a.start - b.start);
    for (let i = 0; i < finalCards.length - 1; i++) {
      if (finalCards[i].end > finalCards[i + 1].start - 0.02) {
        finalCards[i].end = Math.max(
          finalCards[i].start + 0.25,
          Number((finalCards[i + 1].start - 0.02).toFixed(2))
        );
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

  // SOTA Cut Transition & Color Grade LUT evaluation
  const trans = activeClip
    ? evaluateCutTransitionTransform(activeClip, clipPlayheadTime)
    : { offsetX: 0, extraScale: 1, flashAlpha: 0, chromaticShiftPx: 0 };
  const lutFilterStr = getColorGradeLutCanvasFilter(activeClip?.colorGradeLut);
  const effectiveClipZoom = Math.max(0.5, Math.min(3.2, zoom * (trans.extraScale || 1.0)));

  // Per-Cut Layout Override: allows switching between Split-Screen (2 subjects) and Full-Screen (1 subject)
  const activeCutAtPlayhead = activeClip?.subCuts?.find(
    (c) => clipPlayheadTime >= c.timelineStart - 0.03 && clipPlayheadTime <= c.timelineEnd + 0.03
  );
  const cutLayout = activeCutAtPlayhead?.layoutMode || 'inherit';
  const effectiveFillStyle: BackgroundFillStyle =
    cutLayout === 'split-screen'
      ? 'split-screen'
      : cutLayout === 'full-single' ||
          cutLayout === 'full-speaker-a' ||
          cutLayout === 'full-speaker-b'
        ? backgroundFillStyle === 'black'
          ? 'black'
          : 'blurred'
        : backgroundFillStyle;

  const defaultYForSpeakers = vw < vh ? 0.39 : Math.min(0.48, Math.max(0.34, cropY));
  const fineOffsetXForSpeakers = activeClip?.trackingOffsetX || 0;
  const effectiveCropX =
    cutLayout === 'full-speaker-a'
      ? Math.max(0.06, Math.min(0.94, (activeClip?.speakerAX ?? 0.26) + fineOffsetXForSpeakers))
      : cutLayout === 'full-speaker-b'
        ? Math.max(0.06, Math.min(0.94, (activeClip?.speakerBX ?? 0.74) + fineOffsetXForSpeakers))
        : cropX;
  const effectiveCropY =
    cutLayout === 'full-speaker-a'
      ? Math.max(0.06, Math.min(0.94, activeClip?.speakerAY ?? defaultYForSpeakers))
      : cutLayout === 'full-speaker-b'
        ? Math.max(0.06, Math.min(0.94, activeClip?.speakerBY ?? defaultYForSpeakers))
        : cropY;

  // MODE A: 2-Speaker Top/Bottom 9:16 Podcast Split-Screen
  if (effectiveFillStyle === 'split-screen') {
    const splitRatio = Math.max(0.25, Math.min(0.75, activeClip?.splitScreenRatio ?? 0.5));
    const topH = Math.floor(outH * splitRatio);
    const bottomH = outH - topH;

    const defaultY = vw < vh ? 0.39 : Math.min(0.48, Math.max(0.34, cropY));
    const fineOffsetX = activeClip?.trackingOffsetX || 0;
    const leftX = Math.max(
      0.06,
      Math.min(0.94, (activeClip?.speakerAX ?? 0.26) + fineOffsetX)
    );
    const leftY = Math.max(0.06, Math.min(0.94, activeClip?.speakerAY ?? defaultY));
    const leftScale = Math.max(0.5, Math.min(2.5, activeClip?.speakerAScale ?? 1.0));

    const rightX = Math.max(
      0.06,
      Math.min(0.94, (activeClip?.speakerBX ?? 0.74) + fineOffsetX)
    );
    const rightY = Math.max(0.06, Math.min(0.94, activeClip?.speakerBY ?? defaultY));
    const rightScale = Math.max(0.5, Math.min(2.5, activeClip?.speakerBScale ?? 1.0));

    const drawSpeakerPanel = (
      centerX: number,
      centerY: number,
      speakerScale: number,
      destY: number,
      destH: number
    ) => {
      const panelAspect = outW / Math.max(1, destH);
      const widthFraction = vw < vh ? 0.50 : 0.46;
      const baseZoom = Math.max(0.85, Math.min(2.4, effectiveClipZoom > 1.35 ? 1.0 : effectiveClipZoom));
      const effectiveZoom = Math.max(0.45, Math.min(3.2, baseZoom * speakerScale));
      const sw = Math.max(64, Math.min(vw, (vw * widthFraction) / effectiveZoom));
      const sh = Math.max(64, Math.min(vh, sw / panelAspect));
      const sx = Math.max(0, Math.min(vw - sw, centerX * vw - sw / 2));
      const sy = Math.max(0, Math.min(vh - sh, centerY * vh - sh / 2));
      const vf = activeClip?.videoFilter;
      const filterStr = [
        lutFilterStr,
        vf?.brightness !== undefined ? `brightness(${vf.brightness})` : '',
        vf?.contrast !== undefined ? `contrast(${vf.contrast})` : '',
        vf?.saturation !== undefined ? `saturate(${vf.saturation})` : '',
        vf?.grayscale ? `grayscale(${vf.grayscale})` : '',
        vf?.sepia ? `sepia(${vf.sepia})` : '',
        vf?.hueRotate ? `hue-rotate(${vf.hueRotate}deg)` : '',
      ]
        .filter(Boolean)
        .join(' ');
      const panelDx = Math.round((trans.offsetX || 0) * outW);
      if (filterStr) {
        ctx.save();
        ctx.filter = filterStr;
        ctx.drawImage(videoEl, sx, sy, sw, sh, panelDx, destY, outW, destH);
        ctx.restore();
      } else {
        ctx.drawImage(videoEl, sx, sy, sw, sh, panelDx, destY, outW, destH);
      }
    };

    // Top Panel: Speaker A
    drawSpeakerPanel(leftX, leftY, leftScale, 0, topH);
    // Bottom Panel: Speaker B
    drawSpeakerPanel(rightX, rightY, rightScale, topH, bottomH);

    // Clean divider line between Top & Bottom speaker panels
    ctx.save();
    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, topH - 2, outW, 4);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.fillRect(0, topH - 0.5, outW, 1);
    ctx.restore();
  } else {
    // MODE B: Single-Frame 9:16 Crop OR Wide Letterbox with Blurred / Black Background Fill
    const crop = computeDistortionFree9x16Crop(
      vw,
      vh,
      effectiveCropX,
      effectiveCropY,
      effectiveClipZoom
    );
    const cropAspect = crop.sw / Math.max(1, crop.sh);
    const canvasAspect = outW / outH;

    let dx = Math.round((trans.offsetX || 0) * outW);
    let dy = 0;
    let dw = outW;
    let dh = outH;

    // When zoomed out (< 1.0x), fit the frame with Blurred 9:16 Background Fill or Black Bars
    if (cropAspect > canvasAspect + 0.01 || effectiveClipZoom < 0.99) {
      if (cropAspect > canvasAspect + 0.01) {
        dw = outW;
        dh = Math.round(outWidthToHeight(outW, cropAspect));
        dx = Math.round((trans.offsetX || 0) * outW);
        dy = Math.round((outH - dh) / 2);
      } else {
        // Source is already 9:16 vertical and user zoomed out (< 1.0x): scale down over blurred background
        const scaleFactor = Math.max(0.56, Math.min(1.0, effectiveClipZoom));
        dw = Math.round(outW * scaleFactor);
        dh = Math.round(outH * scaleFactor);
        dx = Math.round((outW - dw) / 2 + (trans.offsetX || 0) * outW);
        dy = Math.round((outH - dh) / 2);
      }

      if (effectiveFillStyle !== 'black') {
        const bgCrop = computeDistortionFree9x16Crop(vw, vh, effectiveCropX, effectiveCropY, 1.12);
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

    const vf = activeClip?.videoFilter;
    const filterStr = [
      lutFilterStr,
      vf?.brightness !== undefined ? `brightness(${vf.brightness})` : '',
      vf?.contrast !== undefined ? `contrast(${vf.contrast})` : '',
      vf?.saturation !== undefined ? `saturate(${vf.saturation})` : '',
      vf?.grayscale ? `grayscale(${vf.grayscale})` : '',
      vf?.sepia ? `sepia(${vf.sepia})` : '',
      vf?.hueRotate ? `hue-rotate(${vf.hueRotate}deg)` : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (filterStr) {
      ctx.save();
      ctx.filter = filterStr;
      ctx.drawImage(videoEl, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
      ctx.restore();
    } else {
      ctx.drawImage(videoEl, crop.sx, crop.sy, crop.sw, crop.sh, dx, dy, dw, dh);
    }

    if (trans.chromaticShiftPx && trans.chromaticShiftPx > 0.5) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ctx.globalCompositeOperation = 'screen';
      ctx.drawImage(
        videoEl,
        crop.sx,
        crop.sy,
        crop.sw,
        crop.sh,
        dx + trans.chromaticShiftPx,
        dy,
        dw,
        dh
      );
      ctx.restore();
    }
  }

  if (trans.flashAlpha && trans.flashAlpha > 0.01) {
    ctx.save();
    ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(0.85, trans.flashAlpha)})`;
    ctx.fillRect(0, 0, outW, outH);
    ctx.restore();
  }

  // Snapshot clean video frame before drawing V4 Banner when 3D Behind-Subject Depth is enabled
  let snapCanvas: HTMLCanvasElement | null = null;
  if (
    activeClip?.overlayBannerBehindSubject &&
    activeClip?.overlayBannerText?.trim() &&
    !activeClip?.hideBannerLayer
  ) {
    snapCanvas = getBehindSubjectSnapshotCanvas(outW, outH);
    const snapCtx = snapCanvas.getContext('2d');
    if (snapCtx) {
      snapCtx.drawImage(ctx.canvas, 0, 0, outW, outH);
    }
  }

  // Draw Optional Title / Hook Banner Overlay Layer (V4) if configured
  if (activeClip?.overlayBannerText?.trim() && !activeClip?.hideBannerLayer) {
    const scale = (outW / 360) * Math.max(0.5, Math.min(2.5, activeClip.overlayBannerScale ?? 1.0));
    const bannerX = outW * Math.max(0.15, Math.min(0.85, activeClip.overlayBannerPositionX ?? 0.5));
    const bannerY = outH * Math.max(0.06, Math.min(0.92, activeClip.overlayBannerPositionY ?? 0.10));
    const bannerFontSize = Math.round(18 * scale);
    ctx.save();
    ctx.font = `800 ${bannerFontSize}px "Anton", "Bebas Neue", Inter, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const bText = activeClip.overlayBannerText.trim();
    const tw = Math.min(outW * 0.9, ctx.measureText(bText).width);
    const padX = Math.round(14 * scale);
    const padY = Math.round(8 * scale);
    ctx.fillStyle = activeClip.overlayBannerBgColor || 'rgba(220, 38, 38, 0.92)';
    ctx.beginPath();
    ctx.roundRect(
      bannerX - tw / 2 - padX,
      bannerY - bannerFontSize / 2 - padY,
      tw + padX * 2,
      bannerFontSize + padY * 2,
      Math.round(6 * scale)
    );
    ctx.fill();
    ctx.fillStyle = activeClip.overlayBannerTextColor || '#ffffff';
    ctx.fillText(bText, bannerX, bannerY, outW * 0.9);
    ctx.restore();

    // MediaPipe ImageSegmenter 3D Depth Matting: composite subject silhouette over the V4 Title Banner
    if (snapCanvas && activeClip.overlayBannerBehindSubject) {
      compositeForegroundSubjectMaskOverText(ctx, snapCanvas, outW, outH);
    }
  }

  // Draw Custom Video Overlay Layers (Text / Lower-Third / Callout / Lottie Vector Layers on Timeline)
  if (activeClip?.overlayLayers && activeClip.overlayLayers.length > 0) {
    for (const layer of activeClip.overlayLayers) {
      if (
        !layer.visible ||
        clipPlayheadTime < layer.startTime - 0.05 ||
        clipPlayheadTime > layer.endTime + 0.05
      ) {
        continue;
      }
      const lx = outW * Math.max(0.1, Math.min(0.9, layer.x ?? 0.5));
      const ly = outH * Math.max(0.06, Math.min(0.94, layer.y ?? 0.18));

      if (layer.lottiePreset && layer.lottiePreset !== 'none') {
        renderLottieStickerOnCanvas(
          ctx,
          layer.lottiePreset,
          lx,
          ly,
          (outW / 360) * Math.max(0.5, Math.min(2.5, layer.scale || 1.0)),
          clipPlayheadTime
        );
      }

      if (!layer.text.trim()) continue;
      const lScale = (outW / 360) * Math.max(0.4, Math.min(2.8, layer.scale || 1.0));
      const lFontSize = Math.round(17 * lScale);
      ctx.save();
      ctx.font = `700 ${lFontSize}px Inter, sans-serif`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const txt = layer.text.trim();
      const tw = Math.min(outW * 0.9, ctx.measureText(txt).width);
      const px = Math.round(12 * lScale);
      const py = Math.round(7 * lScale);
      ctx.fillStyle = layer.bgColor || 'rgba(9, 9, 11, 0.88)';
      ctx.beginPath();
      ctx.roundRect(
        lx - tw / 2 - px,
        ly - lFontSize / 2 - py,
        tw + px * 2,
        lFontSize + py * 2,
        Math.round(5 * lScale)
      );
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = layer.textColor || '#fafafa';
      ctx.fillText(txt, lx, ly, outW * 0.9);
      ctx.restore();
    }
  }

  // Draw Styled Social Captions + Word-Level Karaoke Highlighting
  if (activeClip && !activeClip.hideCaptions) {
    renderWordLevelCaptionOverlay(ctx, outW, outH, activeClip, clipPlayheadTime);
  }
}

function outWidthToHeight(outW: number, cropAspect: number): number {
  return outW / Math.max(0.1, cropAspect);
}

/**
 * Renders Hormozi Bold / Neon Karaoke / Street Graffiti / Premiere Minimal / Cinema Serif captions
 * with full Studio Agent control over Y-position (top/middle/bottom), font family (graffiti, marker,
 * bangers, impact, bebas, serif, mono, inter), font size scale, colors, and background box!
 */
export function renderWordLevelCaptionOverlay(
  ctx: CanvasRenderingContext2D,
  outW: number,
  outH: number,
  clip: GeneratedClip,
  clipPlayheadTime: number
) {
  if (clip.hideCaptions) return;
  const seg = clip.captions.find(
    (c) => clipPlayheadTime >= c.start - 0.05 && clipPlayheadTime <= c.end + 0.05
  );
  // Only fall back to static clip.captionText if clip.captions is completely empty
  const text = (seg ? seg.text : clip.captions.length === 0 ? clip.captionText : '').trim();
  if (!text) return;

  const scale = outW / 360;
  const style: CaptionStyleId = clip.captionStyle || 'hormozi-bold';
  const fontChoice =
    clip.captionFontFamily ||
    (style === 'street-graffiti'
      ? 'graffiti'
      : style === 'cinema-serif'
        ? 'serif'
        : 'inter');

  const normY = Math.max(0.08, Math.min(0.92, clip.captionPositionY ?? 0.77));
  const normX = Math.max(0.18, Math.min(0.82, clip.captionPositionX ?? 0.5));
  const yPos = outH * normY;
  const xCenter = outW * normX;
  const fontScale = Math.max(0.5, Math.min(2.2, clip.captionFontScale ?? 1.0));

  ctx.save();
  ctx.textBaseline = 'middle';

  const baseSize =
    fontChoice === 'graffiti' || fontChoice === 'bangers' || fontChoice === 'marker'
      ? 25
      : fontChoice === 'impact' || fontChoice === 'bebas'
        ? 26
        : style === 'hormozi-bold'
          ? 23
          : style === 'neon-karaoke'
            ? 22
            : 19;
  const fontSize = Math.round(baseSize * scale * fontScale);

  const fontFamily =
    fontChoice === 'graffiti'
      ? `400 ${fontSize}px "Rubik Spray Paint", "Sedgwick Ave Display", "Permanent Marker", "Bangers", cursive`
      : fontChoice === 'marker'
        ? `400 ${fontSize}px "Permanent Marker", "Bangers", cursive`
        : fontChoice === 'bangers'
          ? `400 ${fontSize}px "Bangers", Impact, cursive`
          : fontChoice === 'impact'
            ? `400 ${fontSize}px "Anton", Impact, sans-serif`
            : fontChoice === 'bebas'
              ? `400 ${fontSize}px "Bebas Neue", "Anton", sans-serif`
              : fontChoice === 'serif'
                ? `700 ${fontSize}px "Playfair Display", Georgia, serif`
                : fontChoice === 'mono'
                  ? `700 ${fontSize}px "JetBrains Mono", monospace`
                  : `800 ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.font = fontFamily;

  const rawWords = text.split(/\s+/).filter(Boolean);
  const segStart = seg ? seg.start : 0;
  const segEnd = seg
    ? seg.end
    : Math.min(clip.duration, segStart + Math.max(1.2, rawWords.length * 0.35));
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
  const maxLineW = outW * 0.86;

  interface MeasuredWord {
    word: string;
    displayWord: string;
    width: number;
    isActive: boolean;
    isPast: boolean;
  }

  const shouldUppercase =
    clip.captionUppercase !== undefined
      ? clip.captionUppercase
      : style === 'hormozi-bold' ||
        style === 'neon-karaoke' ||
        style === 'street-graffiti' ||
        fontChoice === 'graffiti' ||
        fontChoice === 'bangers' ||
        fontChoice === 'impact' ||
        fontChoice === 'bebas';

  const measured: MeasuredWord[] = wordsWithTiming.map((wt) => {
    const displayWord = shouldUppercase ? wt.word.toUpperCase() : wt.word;
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

  const bgOpacity =
    clip.captionBgOpacity !== undefined
      ? clip.captionBgOpacity
      : fontChoice === 'graffiti'
        ? 0.52
        : style === 'premiere-minimal'
          ? 0.82
          : 0.68;

  if (bgOpacity > 0.02) {
    ctx.fillStyle =
      clip.captionBgColor ||
      (style === 'premiere-minimal'
        ? `rgba(15, 23, 42, ${bgOpacity})`
        : `rgba(0, 0, 0, ${bgOpacity})`);
    ctx.beginPath();
    ctx.roundRect(
      xCenter - widestLineW / 2 - padX,
      startY - lineHeight / 2 - padY,
      widestLineW + padX * 2,
      totalBlockH + padY * 2,
      Math.round(8 * scale)
    );
    ctx.fill();
  }

  const activeHighlightColor =
    clip.captionHighlightColor ||
    (fontChoice === 'graffiti' || style === 'street-graffiti'
      ? '#ff2a85'
      : style === 'neon-karaoke'
        ? '#34d399'
        : '#facc15');
  const baseTextColor = clip.captionTextColor || '#ffffff';

  lines.forEach((ln, lineIdx) => {
    const lineW = ln.reduce((acc, w, i) => acc + w.width + (i > 0 ? spaceW : 0), 0);
    let cursorX = xCenter - lineW / 2;
    const lineY = startY + lineIdx * lineHeight;

    for (const mw of ln) {
      if (mw.isActive) {
        ctx.save();
        ctx.fillStyle =
          fontChoice === 'graffiti' || style === 'street-graffiti'
            ? 'rgba(255, 42, 133, 0.28)'
            : style === 'neon-karaoke'
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

      // Graffiti / Bold street drop-shadow + thick outline + optional Spring-Physics Word Pop-In
      ctx.save();
      if (mw.isActive && clip.captionSpringPhysics) {
        const wordCenterX = cursorX + mw.width / 2;
        ctx.translate(wordCenterX, lineY);
        ctx.scale(1.16, 1.16);
        ctx.translate(-wordCenterX, -lineY - 2 * scale);
      }
      if (fontChoice === 'graffiti' || fontChoice === 'marker' || fontChoice === 'bangers') {
        ctx.shadowColor = mw.isActive ? 'rgba(255, 42, 133, 0.85)' : 'rgba(0, 0, 0, 0.95)';
        ctx.shadowBlur = Math.round(6 * scale);
        ctx.shadowOffsetX = Math.round(2 * scale);
        ctx.shadowOffsetY = Math.round(2 * scale);
      }

      ctx.lineWidth = Math.max(
        2,
        Math.round((fontChoice === 'graffiti' ? 4.2 : 3.2) * scale * fontScale)
      );
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.96)';
      ctx.strokeText(mw.displayWord, cursorX, lineY);

      if (mw.isActive) {
        ctx.fillStyle = activeHighlightColor;
      } else if (mw.isPast && style === 'neon-karaoke') {
        ctx.fillStyle = '#e2e8f0';
      } else {
        ctx.fillStyle = baseTextColor;
      }

      ctx.fillText(mw.displayWord, cursorX, lineY);
      ctx.restore();
      cursorX += mw.width + spaceW;
    }
  });

  ctx.restore();
}
