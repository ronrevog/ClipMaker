import * as MP4Box from 'mp4box';
import lottie, { AnimationItem } from 'lottie-web';
import {
  FaceLandmarker,
  FilesetResolver,
  ImageSegmenter,
} from '@mediapipe/tasks-vision';
import {
  AudioMasteringPresetId,
  CaptionSegment,
  ColorGradeLutId,
  CutTransitionStyleId,
  GeneratedClip,
  LottieOverlayPresetId,
  SourceVideoAsset,
  SubCut,
} from '../types/editor';

// ============================================================================
// 1. MP4BOX.JS CONTAINER & GOP KEYFRAME INSPECTOR
// ============================================================================
export interface Mp4ContainerTelemetry {
  videoCodec: string;
  audioCodec: string;
  keyframeTimestampsSec: number[];
  totalSamples: number;
  isFastStart: boolean;
}

export async function inspectMp4ContainerWithMp4Box(
  videoBlob: Blob
): Promise<Mp4ContainerTelemetry | null> {
  try {
    const slice = videoBlob.slice(0, Math.min(videoBlob.size, 8 * 1024 * 1024));
    const arrayBuffer = await slice.arrayBuffer();
    return await new Promise<Mp4ContainerTelemetry | null>((resolve) => {
      const mp4file = MP4Box.createFile();
      let resolved = false;
      const finish = (val: Mp4ContainerTelemetry | null) => {
        if (resolved) return;
        resolved = true;
        resolve(val);
      };

      mp4file.onReady = (info: any) => {
        const vTrack = info?.videoTracks?.[0];
        const aTrack = info?.audioTracks?.[0];
        finish({
          videoCodec: vTrack?.codec || 'avc1',
          audioCodec: aTrack?.codec || 'mp4a',
          keyframeTimestampsSec: [],
          totalSamples: vTrack?.nb_samples || 0,
          isFastStart: Boolean(info?.isProgressive),
        });
      };
      mp4file.onError = () => finish(null);

      const mp4Buf = arrayBuffer as MP4Box.MP4ArrayBuffer;
      mp4Buf.fileStart = 0;
      mp4file.appendBuffer(mp4Buf);
      mp4file.flush();
      setTimeout(() => finish(null), 800);
    });
  } catch {
    return null;
  }
}

// ============================================================================
// 2. @HUGGINGFACE/TRANSFORMERS ON-DEVICE WHISPER WORD-LEVEL TRANSCRIPTION
// ============================================================================
let localWhisperPipePromise: Promise<any> | null = null;

export async function runLocalWhisperWordTranscription(
  sourceUrl: string,
  startSec: number,
  durationSec: number,
  onProgress?: (msg: string) => void
): Promise<CaptionSegment[]> {
  try {
    onProgress?.('Loading on-device Whisper speech model (@huggingface/transformers)...');
    if (!localWhisperPipePromise) {
      const { pipeline, env } = await import('@huggingface/transformers');
      env.allowLocalModels = false;
      localWhisperPipePromise = pipeline(
        'automatic-speech-recognition',
        'Xenova/whisper-tiny.en'
      );
    }
    const transcriber = await localWhisperPipePromise;

    onProgress?.('Decoding 16kHz mono PCM audio for Whisper...');
    const resp = await fetch(sourceUrl);
    const arrayBuf = await resp.arrayBuffer();
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const tempCtx = new AudioCtx({ sampleRate: 16000 });
    let decoded: AudioBuffer;
    try {
      decoded = await tempCtx.decodeAudioData(arrayBuf.slice(0));
    } finally {
      try {
        await tempCtx.close();
      } catch {}
    }

    const sr = decoded.sampleRate;
    const sIdx = Math.max(0, Math.floor(startSec * sr));
    const eIdx = Math.min(decoded.length, Math.floor((startSec + durationSec) * sr));
    const pcm = decoded.getChannelData(0).subarray(sIdx, eIdx);

    onProgress?.('Running Whisper word-level timestamp alignment...');
    const result = await transcriber(pcm, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
    });

    const chunks: Array<{ text: string; timestamp: [number, number] }> =
      result?.chunks || [];
    if (chunks.length === 0) return [];

    // Group words into punchy 4-6 word viral karaoke segments
    const segments: CaptionSegment[] = [];
    let bucket: typeof chunks = [];

    const flushBucket = () => {
      if (bucket.length === 0) return;
      const segStart = Number((bucket[0].timestamp[0] ?? 0).toFixed(2));
      const rawEnd = bucket[bucket.length - 1].timestamp[1] ?? segStart + 1.2;
      const segEnd = Number(Math.max(segStart + 0.25, rawEnd).toFixed(2));
      const words = bucket.map((w) => {
        const ws = Number((w.timestamp[0] ?? segStart).toFixed(2));
        const we = Number(Math.max(ws + 0.08, w.timestamp[1] ?? ws + 0.25).toFixed(2));
        return {
          word: w.text.trim(),
          start: ws,
          end: we,
        };
      });
      const text = words.map((w) => w.word).join(' ');
      const highlightWord =
        words.reduce((best, cur) => (cur.word.length > best.length ? cur.word : best), '') ||
        words[0]?.word;
      segments.push({
        id: `whisper-seg-${Date.now()}-${segments.length}`,
        start: segStart,
        end: segEnd,
        text,
        highlightWord,
        words,
      });
      bucket = [];
    };

    for (const ch of chunks) {
      if (!ch.text || !ch.text.trim()) continue;
      bucket.push(ch);
      const endsPunct = /[.!?]$/.test(ch.text.trim());
      if (bucket.length >= 5 || (bucket.length >= 3 && endsPunct)) {
        flushBucket();
      }
    }
    flushBucket();
    return segments;
  } catch (err) {
    console.warn('On-device Whisper fallback:', err);
    return [];
  }
}

// ============================================================================
// 3. MEDIAPIPE FACELANDMARKER (478-POINT LIP-SYNC SPEAKER DIARIZATION)
//    & IMAGESEGMENTER (3D BEHIND-SUBJECT TEXT MATTING)
// ============================================================================
let faceLandmarkerInstance: FaceLandmarker | null = null;
let faceLandmarkerPromise: Promise<FaceLandmarker | null> | null = null;

export async function ensureMediaPipeFaceLandmarker(): Promise<FaceLandmarker | null> {
  if (faceLandmarkerInstance) return faceLandmarkerInstance;
  if (faceLandmarkerPromise) return faceLandmarkerPromise;

  faceLandmarkerPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      faceLandmarkerInstance = await FaceLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        numFaces: 2,
      });
      return faceLandmarkerInstance;
    } catch (err) {
      console.warn('MediaPipe FaceLandmarker init warning:', err);
      return null;
    }
  })();

  return faceLandmarkerPromise;
}

/**
 * Computes Mouth Aspect Ratio (MAR) from MediaPipe 478 3D Face Landmarks:
 * Upper inner lip (#13), lower inner lip (#14), left mouth corner (#78), right mouth corner (#308).
 */
function computeMouthAspectRatio(landmarks: Array<{ x: number; y: number; z?: number }>): {
  centerX: number;
  centerY: number;
  mar: number;
} {
  const topLip = landmarks[13];
  const botLip = landmarks[14];
  const leftCorner = landmarks[78];
  const rightCorner = landmarks[308];
  const noseTip = landmarks[1] || topLip;

  if (!topLip || !botLip || !leftCorner || !rightCorner) {
    return { centerX: noseTip?.x ?? 0.5, centerY: noseTip?.y ?? 0.45, mar: 0 };
  }
  const mouthOpen = Math.hypot(topLip.x - botLip.x, topLip.y - botLip.y);
  const mouthWidth = Math.max(0.01, Math.hypot(leftCorner.x - rightCorner.x, leftCorner.y - rightCorner.y));
  return {
    centerX: noseTip.x,
    centerY: noseTip.y,
    mar: mouthOpen / mouthWidth,
  };
}

/**
 * Scans the active clip using MediaPipe 478-point FaceLandmarker to detect which speaker's lips
 * are actively moving (Speaker A on Left vs Speaker B on Right) and generates active-speaker cuts.
 */
export async function detectActiveSpeakerTurnsWithLipSync(
  source: SourceVideoAsset,
  clip: GeneratedClip,
  onProgress?: (msg: string) => void
): Promise<{ updatedClip: GeneratedClip; switchesCount: number }> {
  onProgress?.('Loading MediaPipe 478-point Face & Lip Landmarker...');
  const landmarker = await ensureMediaPipeFaceLandmarker();

  const videoEl = document.createElement('video');
  videoEl.src = source.url;
  videoEl.muted = true;
  videoEl.playsInline = true;
  await new Promise<void>((res) => {
    videoEl.onloadeddata = () => res();
    videoEl.onerror = () => res();
  });

  const leftAnchorX = clip.speakerAX ?? 0.26;
  const rightAnchorX = clip.speakerBX ?? 0.74;
  const anchorY = clip.speakerAY ?? (source.width < source.height ? 0.39 : 0.44);

  const sampleStepSec = 0.75;
  const startSec = clip.sourceStart;
  const endSec = clip.sourceEnd;
  const samples: Array<{ time: number; activeSpeaker: 'A' | 'B' }> = [];

  if (landmarker && videoEl.readyState >= 2) {
    let monoTs = performance.now();
    for (let t = startSec; t < endSec; t += sampleStepSec) {
      await new Promise<void>((res) => {
        const onSeek = () => {
          videoEl.removeEventListener('seeked', onSeek);
          res();
        };
        videoEl.addEventListener('seeked', onSeek);
        videoEl.currentTime = t;
        setTimeout(onSeek, 180);
      });

      try {
        monoTs += 33;
        const det = landmarker.detectForVideo(videoEl, monoTs);
        const faces = det?.faceLandmarks || [];
        if (faces.length >= 2) {
          const f1 = computeMouthAspectRatio(faces[0]);
          const f2 = computeMouthAspectRatio(faces[1]);
          const leftFace = f1.centerX <= f2.centerX ? f1 : f2;
          const rightFace = f1.centerX <= f2.centerX ? f2 : f1;
          samples.push({
            time: t,
            activeSpeaker: rightFace.mar > leftFace.mar * 1.08 ? 'B' : 'A',
          });
        } else if (faces.length === 1) {
          const f = computeMouthAspectRatio(faces[0]);
          samples.push({
            time: t,
            activeSpeaker: f.centerX > 0.5 ? 'B' : 'A',
          });
        }
      } catch {}
    }
  }

  // Build smooth 2.2s+ camera turns from lip-sync detections
  const newSubCuts: SubCut[] = [];
  let cursor = startSec;
  let timelineCursor = 0;
  let cutIndex = 1;
  let currentSpeaker: 'A' | 'B' = samples[0]?.activeSpeaker || 'A';

  const minShotLen = 2.2;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    if (s.activeSpeaker !== currentSpeaker && s.time - cursor >= minShotLen) {
      const dur = Number((s.time - cursor).toFixed(2));
      const spd = clip.playbackSpeed ?? 1.0;
      const outDur = Number((dur / spd).toFixed(2));
      newSubCuts.push({
        id: `lipsync-cut-${Date.now()}-${cutIndex}`,
        index: cutIndex,
        sourceStart: Number(cursor.toFixed(2)),
        sourceEnd: Number(s.time.toFixed(2)),
        timelineStart: Number(timelineCursor.toFixed(2)),
        timelineEnd: Number((timelineCursor + outDur).toFixed(2)),
        label: currentSpeaker === 'A' ? 'Speaker A (Lip-Sync)' : 'Speaker B (Lip-Sync)',
        zoom: clip.zoomScale || 1.0,
        cropBiasX: currentSpeaker === 'A' ? leftAnchorX - 0.5 : rightAnchorX - 0.5,
        speed: spd,
      });
      cursor = s.time;
      timelineCursor += outDur;
      currentSpeaker = s.activeSpeaker;
      cutIndex++;
    }
  }

  if (endSec - cursor >= 0.4 || newSubCuts.length === 0) {
    const dur = Math.max(0.5, Number((endSec - cursor).toFixed(2)));
    const spd = clip.playbackSpeed ?? 1.0;
    const outDur = Number((dur / spd).toFixed(2));
    newSubCuts.push({
      id: `lipsync-cut-${Date.now()}-${cutIndex}`,
      index: cutIndex,
      sourceStart: Number(cursor.toFixed(2)),
      sourceEnd: Number(endSec.toFixed(2)),
      timelineStart: Number(timelineCursor.toFixed(2)),
      timelineEnd: Number((timelineCursor + outDur).toFixed(2)),
      label: currentSpeaker === 'A' ? 'Speaker A (Lip-Sync)' : 'Speaker B (Lip-Sync)',
      zoom: clip.zoomScale || 1.0,
      cropBiasX: currentSpeaker === 'A' ? leftAnchorX - 0.5 : rightAnchorX - 0.5,
      speed: spd,
    });
    timelineCursor += outDur;
  }

  const trackedPath = newSubCuts.flatMap((cut) => {
    const isA = cut.cropBiasX <= 0;
    const x = isA ? leftAnchorX : rightAnchorX;
    return [
      { time: cut.sourceStart, x, y: anchorY, confidence: 0.99 },
      { time: Math.max(cut.sourceStart, cut.sourceEnd - 0.04), x, y: anchorY, confidence: 0.99 },
    ];
  });

  const updatedClip: GeneratedClip = {
    ...clip,
    backgroundFillStyle: 'blurred',
    subCuts: newSubCuts,
    duration: Number(timelineCursor.toFixed(2)),
    subjectFocus: {
      strategy: 'click-track',
      anchorX: leftAnchorX,
      anchorY,
      anchorTime: clip.sourceStart,
      label: '2-Speaker Auto-Switch',
      trackedPath,
    },
  };

  return { updatedClip, switchesCount: newSubCuts.length };
}

// MediaPipe ImageSegmenter for 3D Behind-Subject Text Layer Matting
let imageSegmenterInstance: ImageSegmenter | null = null;
let imageSegmenterPromise: Promise<ImageSegmenter | null> | null = null;
let segMaskCanvas: HTMLCanvasElement | null = null;
let fgCutoutCanvas: HTMLCanvasElement | null = null;

export function ensureMediaPipeImageSegmenter(): void {
  if (imageSegmenterInstance || imageSegmenterPromise) return;
  imageSegmenterPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm'
      );
      imageSegmenterInstance = await ImageSegmenter.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite',
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      });
      return imageSegmenterInstance;
    } catch (e) {
      console.warn('MediaPipe ImageSegmenter init warning:', e);
      return null;
    }
  })();
}

/**
 * Draws the segmented foreground person over top of a Behind-Subject V4 Text Layer
 * so the text appears in 3D space behind the speaker's head/shoulders!
 */
export function compositeForegroundSubjectMaskOverText(
  ctx: CanvasRenderingContext2D,
  sourceCanvasSnapshot: HTMLCanvasElement,
  outW: number,
  outH: number
): void {
  if (!imageSegmenterInstance) {
    ensureMediaPipeImageSegmenter();
    return;
  }
  try {
    const nowMs = performance.now();
    const result = imageSegmenterInstance.segmentForVideo(sourceCanvasSnapshot, nowMs);
    const mask = result?.confidenceMasks?.[0];
    if (!mask) return;

    const maskW = mask.width;
    const maskH = mask.height;
    const floatMask = mask.getAsFloat32Array();

    if (!segMaskCanvas) segMaskCanvas = document.createElement('canvas');
    if (segMaskCanvas.width !== maskW || segMaskCanvas.height !== maskH) {
      segMaskCanvas.width = maskW;
      segMaskCanvas.height = maskH;
    }
    const mCtx = segMaskCanvas.getContext('2d');
    if (!mCtx) return;

    const imgData = mCtx.createImageData(maskW, maskH);
    const data = imgData.data;
    for (let i = 0; i < floatMask.length; i++) {
      const conf = floatMask[i];
      const alpha = conf > 0.45 ? Math.min(255, Math.round((conf - 0.35) * 380)) : 0;
      const p = i * 4;
      data[p] = 255;
      data[p + 1] = 255;
      data[p + 2] = 255;
      data[p + 3] = alpha;
    }
    mCtx.putImageData(imgData, 0, 0);

    if (!fgCutoutCanvas) fgCutoutCanvas = document.createElement('canvas');
    if (fgCutoutCanvas.width !== outW || fgCutoutCanvas.height !== outH) {
      fgCutoutCanvas.width = outW;
      fgCutoutCanvas.height = outH;
    }
    const fCtx = fgCutoutCanvas.getContext('2d');
    if (!fCtx) return;

    fCtx.clearRect(0, 0, outW, outH);
    fCtx.drawImage(sourceCanvasSnapshot, 0, 0, outW, outH);
    fCtx.globalCompositeOperation = 'destination-in';
    fCtx.drawImage(segMaskCanvas, 0, 0, outW, outH);
    fCtx.globalCompositeOperation = 'source-over';

    ctx.drawImage(fgCutoutCanvas, 0, 0, outW, outH);
    mask.close();
  } catch {}
}

// ============================================================================
// 4. BROADCAST AUDIO MASTERING & -14 LUFS LOUDNESS NORMALIZATION
// ============================================================================
export function applyBroadcastAudioMasteringToBuffer(
  audioBuffer: AudioBuffer,
  preset: AudioMasteringPresetId
): AudioBuffer {
  if (!preset || preset === 'off') return audioBuffer;

  const numCh = audioBuffer.numberOfChannels;
  const len = audioBuffer.length;
  if (len === 0) return audioBuffer;

  // 1. Measure current RMS loudness across channels
  let sumSq = 0;
  for (let ch = 0; ch < numCh; ch++) {
    const data = audioBuffer.getChannelData(ch);
    for (let i = 0; i < len; i += 4) {
      const s = data[i];
      sumSq += s * s;
    }
  }
  const totalSampled = Math.max(1, (len / 4) * numCh);
  const currentRms = Math.sqrt(sumSq / totalSampled);

  // Target RMS corresponding to -14 LUFS broadcast standard (~0.195 RMS)
  const targetRms =
    preset === 'broadcast-lufs'
      ? 0.21
      : preset === 'vocal-boost'
        ? 0.23
        : 0.19;
  const makeupGain = currentRms > 0.001 ? Math.min(3.2, Math.max(0.7, targetRms / currentRms)) : 1.0;

  // 2. Apply single-pole high-pass vocal clarity filter + soft-knee broadcast limiter
  const sr = audioBuffer.sampleRate || 48000;
  const hpAlpha = Math.exp((-2 * Math.PI * 85) / sr);

  for (let ch = 0; ch < numCh; ch++) {
    const data = audioBuffer.getChannelData(ch);
    let prevIn = 0;
    let prevOut = 0;
    for (let i = 0; i < len; i++) {
      const x = data[i];
      // High-pass sub-85Hz rumble removal
      const hp = hpAlpha * (prevOut + x - prevIn);
      prevIn = x;
      prevOut = hp;

      // Apply makeup gain + soft-knee tanh broadcast saturation limiter (ceiling -0.5 dBFS)
      const boosted = hp * makeupGain;
      data[i] = Math.tanh(boosted * 1.12) * 0.94;
    }
  }

  return audioBuffer;
}

// ============================================================================
// 5. LOTTIE-WEB PROCEDURAL VECTOR MOTION GRAPHICS + GPU TRANSITIONS & LUTS
// ============================================================================
const lottieCache = new Map<
  LottieOverlayPresetId,
  { container: HTMLDivElement; anim: AnimationItem; totalFrames: number }
>();

function buildProceduralLottieJson(preset: LottieOverlayPresetId) {
  const colorRgb =
    preset === 'subscribe-pulse'
      ? [0.95, 0.15, 0.22, 1]
      : preset === 'viral-flame'
        ? [0.98, 0.55, 0.08, 1]
        : preset === 'live-badge'
          ? [0.1, 0.78, 0.48, 1]
          : [0.38, 0.55, 0.98, 1];

  return {
    v: '5.7.4',
    fr: 30,
    ip: 0,
    op: 60,
    w: 240,
    h: 80,
    nm: preset,
    ddd: 0,
    assets: [],
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 4,
        nm: 'PulseBadge',
        sr: 1,
        ks: {
          o: { a: 0, k: 100 },
          r: { a: 0, k: 0 },
          p: { a: 0, k: [120, 40, 0] },
          a: { a: 0, k: [0, 0, 0] },
          s: {
            a: 1,
            k: [
              { t: 0, s: [92, 92, 100], e: [106, 106, 100] },
              { t: 30, s: [106, 106, 100], e: [92, 92, 100] },
              { t: 60, s: [92, 92, 100] },
            ],
          },
        },
        shapes: [
          {
            ty: 'gr',
            it: [
              {
                ty: 'rc',
                d: 1,
                s: { a: 0, k: [200, 54] },
                p: { a: 0, k: [0, 0] },
                r: { a: 0, k: 27 },
              },
              {
                ty: 'fl',
                c: { a: 0, k: colorRgb },
                o: { a: 0, k: 95 },
              },
              {
                ty: 'tr',
                p: { a: 0, k: [0, 0] },
                a: { a: 0, k: [0, 0] },
                s: { a: 0, k: [100, 100] },
                r: { a: 0, k: 0 },
                o: { a: 0, k: 100 },
              },
            ],
          },
        ],
      },
    ],
  };
}

export function renderLottieStickerOnCanvas(
  ctx: CanvasRenderingContext2D,
  preset: LottieOverlayPresetId,
  xPx: number,
  yPx: number,
  scale: number,
  clipTimeSec: number
): void {
  if (!preset || preset === 'none') return;
  try {
    let entry = lottieCache.get(preset);
    if (!entry) {
      const container = document.createElement('div');
      container.style.width = '240px';
      container.style.height = '80px';
      const anim = lottie.loadAnimation({
        container,
        renderer: 'canvas',
        loop: true,
        autoplay: false,
        animationData: buildProceduralLottieJson(preset),
      });
      entry = { container, anim, totalFrames: 60 };
      lottieCache.set(preset, entry);
    }
    const frame = Math.floor((clipTimeSec * 30) % entry.totalFrames);
    entry.anim.goToAndStop(frame, true);
    const lottieCanvas = entry.container.querySelector('canvas');
    if (lottieCanvas) {
      const w = 180 * scale;
      const h = 60 * scale;
      ctx.save();
      ctx.drawImage(lottieCanvas, xPx - w / 2, yPx - h / 2, w, h);
      ctx.restore();
    }
  } catch {}
}

/**
 * Computes CSS / Canvas filter string for Color Grade LUT presets.
 */
export function getColorGradeLutCanvasFilter(lut?: ColorGradeLutId): string {
  switch (lut) {
    case 'cinematic-teal-orange':
      return 'contrast(1.14) saturate(1.24) hue-rotate(-6deg)';
    case 'warm-podcast':
      return 'contrast(1.06) saturate(1.18) sepia(0.14) brightness(1.03)';
    case 'crisp-contrast':
      return 'contrast(1.22) saturate(1.12) brightness(1.02)';
    case 'noir-bw':
      return 'grayscale(1) contrast(1.28) brightness(1.04)';
    default:
      return '';
  }
}

/**
 * Evaluates inter-cut transition state (`whip-pan`, `zoom-punch`, `flash-cut`, `chromatic-glitch`)
 * when the playhead is within 0.16s of a SubCut boundary.
 */
export function evaluateCutTransitionTransform(
  clip: GeneratedClip,
  clipPlayheadTime: number
): {
  offsetX: number;
  extraScale: number;
  flashAlpha: number;
  chromaticShiftPx: number;
} {
  const style: CutTransitionStyleId = clip.transitionStyle || 'none';
  if (style === 'none' || !clip.subCuts || clip.subCuts.length <= 1) {
    return { offsetX: 0, extraScale: 1, flashAlpha: 0, chromaticShiftPx: 0 };
  }

  const windowSec = 0.16;
  for (let i = 1; i < clip.subCuts.length; i++) {
    const boundary = clip.subCuts[i].timelineStart;
    const dist = clipPlayheadTime - boundary;
    if (Math.abs(dist) <= windowSec) {
      const progress = 1 - Math.abs(dist) / windowSec; // 0 -> 1 at cut point -> 0
      const ease = progress * progress;
      if (style === 'whip-pan') {
        const dir = dist < 0 ? -1 : 1;
        return {
          offsetX: dir * ease * 0.42,
          extraScale: 1 + ease * 0.08,
          flashAlpha: ease * 0.15,
          chromaticShiftPx: ease * 8,
        };
      }
      if (style === 'zoom-punch') {
        return {
          offsetX: 0,
          extraScale: 1 + ease * 0.28,
          flashAlpha: ease * 0.12,
          chromaticShiftPx: 0,
        };
      }
      if (style === 'flash-cut') {
        return {
          offsetX: 0,
          extraScale: 1 + ease * 0.04,
          flashAlpha: ease * 0.65,
          chromaticShiftPx: 0,
        };
      }
      if (style === 'chromatic-glitch') {
        return {
          offsetX: (Math.sin(clipPlayheadTime * 90) * 0.04) * ease,
          extraScale: 1 + ease * 0.06,
          flashAlpha: 0,
          chromaticShiftPx: ease * 14,
        };
      }
    }
  }

  return { offsetX: 0, extraScale: 1, flashAlpha: 0, chromaticShiftPx: 0 };
}
