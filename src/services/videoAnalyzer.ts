import {
  HighEnergyWindow,
  PerSecondTelemetry,
  SourceVideoAsset,
  TrackingSample,
} from '../types/editor';
import { detectFrameSubjectCentroid, solveSmoothedCameraPath } from './subjectTracker';

/**
 * Encodes a downsampled mono AudioBuffer slice (e.g. 8000 Hz, 16-bit PCM WAV) into a base64 string
 * (~350 KB for 22 seconds) so Gemini can natively hear & transcribe the video's real audio track.
 */
function encodeMonoWavBase64(channelData: Float32Array, srcSampleRate: number, maxSeconds = 22): string {
  const targetRate = 8000;
  const ratio = Math.max(1, Math.floor(srcSampleRate / targetRate));
  const maxSrcSamples = Math.min(channelData.length, Math.floor(srcSampleRate * maxSeconds));
  const numSamples = Math.floor(maxSrcSamples / ratio);

  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  const actualRate = Math.round(srcSampleRate / ratio);
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + numSamples * 2, true);
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
  view.setUint32(40, numSamples * 2, true);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.max(-1, Math.min(1, channelData[i * ratio]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }

  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + chunkSize))
    );
  }
  return btoa(binary);
}

/**
 * Extracts real RMS audio waveform peaks, transient timestamps, high-energy non-silent windows,
 * and a compact WAV audio sample from an uploaded video file.
 */
async function extractAudioTelemetry(
  file: File,
  duration: number,
  bucketCount = 240
): Promise<{
  peaks: number[];
  audioPeakTimestamps: number[];
  highEnergyWindows: HighEnergyWindow[];
  audioSampleBase64?: string;
}> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioCtx();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const channelData = audioBuffer.getChannelData(0);
    const samplesPerBucket = Math.max(1, Math.floor(channelData.length / bucketCount));

    const peaks: number[] = [];
    let maxPeak = 0.0001;

    for (let i = 0; i < bucketCount; i++) {
      const start = i * samplesPerBucket;
      const end = Math.min(channelData.length, start + samplesPerBucket);
      let sumSq = 0;
      const stride = Math.max(1, Math.floor((end - start) / 256));
      let count = 0;
      for (let j = start; j < end; j += stride) {
        sumSq += channelData[j] * channelData[j];
        count++;
      }
      const rms = Math.sqrt(sumSq / Math.max(1, count));
      peaks.push(rms);
      if (rms > maxPeak) maxPeak = rms;
    }

    const normalized = peaks.map((p) => Number(Math.min(1, p / maxPeak).toFixed(3)));
    const audioPeakTimestamps: number[] = [];
    for (let i = 1; i < normalized.length - 1; i++) {
      if (
        normalized[i] > 0.52 &&
        normalized[i] >= normalized[i - 1] &&
        normalized[i] >= normalized[i + 1]
      ) {
        const t = Number(((i / bucketCount) * duration).toFixed(2));
        if (
          audioPeakTimestamps.length === 0 ||
          t - audioPeakTimestamps[audioPeakTimestamps.length - 1] > 0.75
        ) {
          audioPeakTimestamps.push(t);
        }
      }
    }

    const highEnergyWindows: HighEnergyWindow[] = [];
    const windowBuckets = Math.max(6, Math.floor(bucketCount / 8));
    const stepBuckets = Math.max(3, Math.floor(windowBuckets / 2));
    for (let startB = 0; startB + windowBuckets <= bucketCount; startB += stepBuckets) {
      const slice = normalized.slice(startB, startB + windowBuckets);
      const avgEnergy = slice.reduce((a, b) => a + b, 0) / slice.length;
      const startSec = Number(((startB / bucketCount) * duration).toFixed(2));
      const endSec = Number((((startB + windowBuckets) / bucketCount) * duration).toFixed(2));
      const peakCount = audioPeakTimestamps.filter((p) => p >= startSec && p <= endSec).length;
      highEnergyWindows.push({
        start: startSec,
        end: endSec,
        avgEnergy: Number(avgEnergy.toFixed(3)),
        peakCount,
      });
    }
    highEnergyWindows.sort((a, b) => b.avgEnergy - a.avgEnergy);

    const audioSampleBase64 = encodeMonoWavBase64(channelData, audioBuffer.sampleRate, 22);
    await audioCtx.close();

    return {
      peaks: normalized,
      audioPeakTimestamps,
      highEnergyWindows: highEnergyWindows.slice(0, 8),
      audioSampleBase64,
    };
  } catch (err) {
    console.warn('Audio decode fallback (video may have no audio stream):', err);
    const peaks = new Array(bucketCount).fill(0.25);
    return { peaks, audioPeakTimestamps: [], highEnergyWindows: [] };
  }
}

/**
 * Computes per-second viral telemetry (`audioEnergy`, `motionEnergy`, `viralScore`, `isSilent`)
 * across the entire video duration so Viral Clips and Compilation Cutdowns score real highlights.
 */
function buildPerSecondTelemetry(
  duration: number,
  waveformPeaks: number[],
  trackingSamples: TrackingSample[],
  sceneCutTimestamps: number[]
): PerSecondTelemetry[] {
  const totalSecs = Math.max(1, Math.ceil(duration));
  const telemetry: PerSecondTelemetry[] = [];

  for (let sec = 0; sec < totalSecs; sec++) {
    const tMid = Math.min(duration, sec + 0.5);
    const bucketIdx = Math.min(
      waveformPeaks.length - 1,
      Math.max(0, Math.floor((tMid / Math.max(1, duration)) * waveformPeaks.length))
    );
    const audioEnergy = waveformPeaks[bucketIdx] ?? 0.25;

    // Nearest tracking sample for motion energy
    let nearestSample = trackingSamples[0];
    let bestDist = Infinity;
    for (const s of trackingSamples) {
      const d = Math.abs(s.time - tMid);
      if (d < bestDist) {
        bestDist = d;
        nearestSample = s;
      }
    }
    const motionEnergy = Math.min(1, (nearestSample?.motionScore ?? 20) / 80);
    const nearCut = sceneCutTimestamps.some((c) => Math.abs(c - tMid) < 0.8) ? 0.15 : 0;
    const isSilent = audioEnergy < 0.14;

    const rawViral =
      audioEnergy * 56 +
      motionEnergy * 34 +
      nearCut * 100 -
      (isSilent ? 22 : 0);

    telemetry.push({
      time: sec,
      audioEnergy: Number(audioEnergy.toFixed(3)),
      motionEnergy: Number(motionEnergy.toFixed(3)),
      viralScore: Math.max(10, Math.min(99, Math.round(rawViral))),
      isSilent,
    });
  }

  return telemetry;
}

/**
 * Analyzes an uploaded video file by decoding real audio + sampling real video frames
 * across its duration to detect scene cuts, localized subject clusters (using 12x6 spatial grid +
 * Chromium FaceDetector if available), per-second viral telemetry, and keyframe JPEGs for AI analysis.
 */
export async function analyzeUploadedVideo(
  file: File,
  onProgress?: (stage: string, pct: number) => void
): Promise<SourceVideoAsset> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';

  await new Promise<void>((resolve, reject) => {
    video.onloadeddata = () => resolve();
    video.onerror = () => reject(new Error('Could not decode video file'));
  });

  const duration = Math.max(1, Number.isFinite(video.duration) ? video.duration : 30);
  const width = video.videoWidth || 1920;
  const height = video.videoHeight || 1080;

  onProgress?.('Decoding real audio track & RMS energy...', 15);
  const { peaks, audioPeakTimestamps, highEnergyWindows, audioSampleBase64 } =
    await extractAudioTelemetry(file, duration);

  const sampleCanvas = document.createElement('canvas');
  const sampleW = 240;
  const sampleH = Math.max(135, Math.round((height / width) * sampleW));
  sampleCanvas.width = sampleW;
  sampleCanvas.height = sampleH;
  const ctx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  let nativeFaceDetector: any = null;
  if (typeof (window as any).FaceDetector === 'function') {
    try {
      nativeFaceDetector = new (window as any).FaceDetector({ fastMode: true, maxDetectedFaces: 3 });
    } catch {
      nativeFaceDetector = null;
    }
  }

  const targetSampleCount = Math.min(90, Math.max(28, Math.ceil(duration * 2.2)));
  const sampleStep = duration / targetSampleCount;
  const keyframeInterval = Math.max(1, Math.floor(targetSampleCount / 8));

  const rawSamples: TrackingSample[] = [];
  const sceneCutTimestamps: number[] = [];
  const sampledFrames: Array<{ time: number; dataUrl: string }> = [];
  let prevBuffer: Uint8ClampedArray | null = null;

  for (let i = 0; i <= targetSampleCount; i++) {
    const t = Math.min(duration - 0.04, i * sampleStep);
    const pct = Math.min(92, 18 + Math.round((i / targetSampleCount) * 74));
    onProgress?.(
      `Scanning frames & tracking subjects (${t.toFixed(1)}s / ${duration.toFixed(1)}s)...`,
      pct
    );

    video.currentTime = Math.max(0, t);
    await new Promise<void>((res) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        video.removeEventListener('seeked', done);
        res();
      };
      video.addEventListener('seeked', done);
      setTimeout(done, 250);
    });

    if (ctx) {
      ctx.drawImage(video, 0, 0, sampleW, sampleH);

      if (i % keyframeInterval === 0 && sampledFrames.length < 8) {
        sampledFrames.push({
          time: Number(t.toFixed(2)),
          dataUrl: sampleCanvas.toDataURL('image/jpeg', 0.68),
        });
      }

      const imgData = ctx.getImageData(0, 0, sampleW, sampleH).data;
      const detection = detectFrameSubjectCentroid(
        imgData,
        prevBuffer,
        sampleW,
        sampleH,
        'primary-subject'
      );

      let finalX = detection.x;
      let finalY = detection.y;
      let faceX = detection.faceX;
      let faceY = detection.faceY;
      let finalConf = detection.confidence;
      let finalLabel = detection.label;

      if (nativeFaceDetector) {
        try {
          const faces = await nativeFaceDetector.detect(sampleCanvas);
          if (faces && faces.length > 0) {
            const box = faces[0].boundingBox;
            const fx = Math.max(0.16, Math.min(0.84, (box.x + box.width / 2) / sampleW));
            const fy = Math.max(0.2, Math.min(0.8, (box.y + box.height / 2) / sampleH));
            finalX = fx;
            finalY = fy;
            faceX = fx;
            faceY = fy;
            finalConf = 0.98;
            finalLabel = 'Detected Face';
          }
        } catch {
          // Ignore if FaceDetector fails on a frame
        }
      }

      if (prevBuffer && detection.sceneDelta > 0.21) {
        if (
          sceneCutTimestamps.length === 0 ||
          t - sceneCutTimestamps[sceneCutTimestamps.length - 1] > 0.8
        ) {
          sceneCutTimestamps.push(Number(t.toFixed(2)));
        }
      }

      rawSamples.push({
        time: Number(t.toFixed(2)),
        rawX: Number(finalX.toFixed(4)),
        rawY: Number(finalY.toFixed(4)),
        cropX: Number(finalX.toFixed(4)),
        cropY: Number(finalY.toFixed(4)),
        leftSubjectX: detection.leftSubjectX,
        rightSubjectX: detection.rightSubjectX,
        faceX: Number(faceX.toFixed(4)),
        faceY: Number(faceY.toFixed(4)),
        motionX: detection.motionX,
        motionY: detection.motionY,
        motionScore: detection.motionScore,
        confidence: Number(finalConf.toFixed(2)),
        subjectLabel: finalLabel,
      });

      prevBuffer = new Uint8ClampedArray(imgData);
    }
  }

  onProgress?.('Solving damped 9:16 camera tracking path...', 96);
  const smoothedSamples = solveSmoothedCameraPath(rawSamples, {
    smoothing: 0.82,
    deadzone: 0.05,
    sceneCuts: sceneCutTimestamps,
  });

  const perSecondTelemetry = buildPerSecondTelemetry(
    duration,
    peaks,
    smoothedSamples,
    sceneCutTimestamps
  );

  onProgress?.('Complete', 100);

  return {
    id: `src-${Date.now()}`,
    name: file.name,
    url,
    duration: Number(duration.toFixed(2)),
    width,
    height,
    fps: 30,
    isSyntheticDemo: false,
    waveformPeaks: peaks,
    sceneCutTimestamps,
    audioPeakTimestamps,
    highEnergyWindows,
    perSecondTelemetry,
    sampledFrames,
    audioSampleBase64,
    trackingSamples: smoothedSamples,
  };
}

/**
 * Creates a real playable demo sequence in memory so the timeline and subject focus tools
 * can also be tested immediately before uploading a local file.
 */
export function createBuiltInPremiereDemoAsset(): SourceVideoAsset {
  const duration = 28.97;
  const sceneCutTimestamps = [0, 7.8, 15.6, 22.4];
  const audioPeakTimestamps = [1.4, 3.8, 6.2, 7.8, 9.3, 11.8, 14.2, 15.6, 18.1, 20.5, 22.4, 25.0, 27.2];

  const rawSamples: TrackingSample[] = [];
  for (let t = 0; t <= duration; t += 0.25) {
    let rawX = 0.5;
    let rawY = 0.5;
    let label = 'Roadster Subject';
    let motionScore = 45;

    if (t < 7.8) {
      rawX = 0.44 + 0.16 * Math.sin(t * 0.75);
      rawY = 0.62 - 0.04 * Math.cos(t * 0.5);
      label = 'Convertible Roadster';
      motionScore = 62;
    } else if (t < 15.6) {
      const localT = t - 7.8;
      rawX = 0.48 + 0.09 * Math.sin(localT * 0.9);
      rawY = 0.38 + Math.min(0.32, localT * 0.045);
      label = 'Waterfall Divers';
      motionScore = 78;
    } else if (t < 22.4) {
      const localT = t - 15.6;
      rawX = 0.54 + 0.07 * Math.cos(localT * 1.1);
      rawY = 0.44 + 0.03 * Math.sin(localT * 1.4);
      label = 'Speaker / Face';
      motionScore = 34;
    } else {
      const localT = t - 22.4;
      rawX = 0.36 + 0.28 * (localT / 6.6);
      rawY = 0.52 - 0.05 * Math.sin(localT * 1.8);
      label = 'Action Subject';
      motionScore = 84;
    }

    rawSamples.push({
      time: Number(t.toFixed(2)),
      rawX: Number(rawX.toFixed(4)),
      rawY: Number(rawY.toFixed(4)),
      cropX: Number(rawX.toFixed(4)),
      cropY: Number(rawY.toFixed(4)),
      leftSubjectX: Number(Math.max(0.22, Math.min(0.45, rawX - 0.16)).toFixed(4)),
      rightSubjectX: Number(Math.max(0.55, Math.min(0.78, rawX + 0.16)).toFixed(4)),
      faceX: Number(rawX.toFixed(4)),
      faceY: Number(Math.max(0.28, rawY - 0.06).toFixed(4)),
      motionX: Number(rawX.toFixed(4)),
      motionY: Number(rawY.toFixed(4)),
      motionScore,
      confidence: 0.94,
      subjectLabel: label,
    });
  }

  const smoothed = solveSmoothedCameraPath(rawSamples, {
    smoothing: 0.82,
    deadzone: 0.05,
    sceneCuts: sceneCutTimestamps,
  });

  const waveformPeaks: number[] = [];
  for (let i = 0; i < 200; i++) {
    const t = (i / 200) * duration;
    const nearBeat = audioPeakTimestamps.some((b) => Math.abs(b - t) < 0.32);
    const val = nearBeat
      ? 0.88 + 0.1 * Math.sin(i)
      : 0.28 + 0.32 * Math.abs(Math.sin(t * 2.9)) + 0.18 * Math.abs(Math.cos(t * 7.1));
    waveformPeaks.push(Number(Math.min(1, val).toFixed(3)));
  }

  const perSecondTelemetry = buildPerSecondTelemetry(
    duration,
    waveformPeaks,
    smoothed,
    sceneCutTimestamps
  );

  return {
    id: 'demo-30-sec-film',
    name: '30 sec Film.mp4 (Synthetic Demo — Upload Any Real Video)',
    url: '',
    duration,
    width: 1920,
    height: 1080,
    fps: 29.97,
    isSyntheticDemo: true,
    waveformPeaks,
    sceneCutTimestamps,
    audioPeakTimestamps,
    perSecondTelemetry,
    trackingSamples: smoothed,
  };
}

export function renderDemoSequenceFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  time: number,
  cropRect?: { sx: number; sy: number; sw: number; sh: number }
) {
  const vw = 960;
  const vh = 540;

  ctx.save();
  if (cropRect) {
    const scaleX = width / (cropRect.sw * vw);
    const scaleY = height / (cropRect.sh * vh);
    ctx.scale(scaleX, scaleY);
    ctx.translate(-cropRect.sx * vw, -cropRect.sy * vh);
  } else {
    ctx.scale(width / vw, height / vh);
  }

  if (time < 7.8) {
    const skyGrad = ctx.createLinearGradient(0, 0, vw, vh * 0.62);
    skyGrad.addColorStop(0, '#c8beb5');
    skyGrad.addColorStop(0.55, '#eadbc8');
    skyGrad.addColorStop(0.85, '#f6d196');
    skyGrad.addColorStop(1, '#f3a852');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, vw, vh);

    ctx.fillStyle = '#332821';
    ctx.beginPath();
    ctx.moveTo(0, vh * 0.22);
    ctx.lineTo(vw * 0.25, vh * 0.28);
    ctx.lineTo(vw * 0.58, vh * 0.43);
    ctx.lineTo(vw * 0.65, vh * 0.56);
    ctx.lineTo(0, vh * 0.56);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#2d2926';
    ctx.beginPath();
    ctx.moveTo(0, vh);
    ctx.lineTo(vw * 0.56, vh * 0.52);
    ctx.lineTo(vw * 0.72, vh * 0.52);
    ctx.lineTo(vw, vh);
    ctx.closePath();
    ctx.fill();

    const sunGrad = ctx.createRadialGradient(vw * 0.72, vh * 0.5, 8, vw * 0.72, vh * 0.5, 220);
    sunGrad.addColorStop(0, 'rgba(255, 244, 195, 0.95)');
    sunGrad.addColorStop(0.35, 'rgba(255, 178, 84, 0.55)');
    sunGrad.addColorStop(1, 'rgba(255, 140, 40, 0)');
    ctx.fillStyle = sunGrad;
    ctx.fillRect(0, 0, vw, vh);

    ctx.strokeStyle = '#d99e4e';
    ctx.lineWidth = 4;
    ctx.setLineDash([28, 18]);
    ctx.lineDashOffset = -time * 120;
    ctx.beginPath();
    ctx.moveTo(vw * 0.18, vh);
    ctx.lineTo(vw * 0.62, vh * 0.53);
    ctx.stroke();
    ctx.setLineDash([]);

    const carX = (0.44 + 0.16 * Math.sin(time * 0.75)) * vw;
    const carY = (0.62 - 0.04 * Math.cos(time * 0.5)) * vh;

    ctx.fillStyle = 'rgba(10, 8, 8, 0.55)';
    ctx.beginPath();
    ctx.ellipse(carX, carY + 38, 78, 16, 0, 0, Math.PI * 2);
    ctx.fill();

    const bodyGrad = ctx.createLinearGradient(carX - 70, carY - 25, carX + 70, carY + 35);
    bodyGrad.addColorStop(0, '#9db6be');
    bodyGrad.addColorStop(0.5, '#bfd4dc');
    bodyGrad.addColorStop(1, '#586d75');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.roundRect(carX - 72, carY - 12, 144, 44, [24, 24, 12, 12]);
    ctx.fill();

    ctx.strokeStyle = '#e2edf2';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(carX - 42, carY - 12);
    ctx.lineTo(carX - 32, carY - 28);
    ctx.lineTo(carX + 32, carY - 28);
    ctx.lineTo(carX + 42, carY - 12);
    ctx.stroke();

    ctx.fillStyle = '#3b281e';
    ctx.beginPath();
    ctx.arc(carX - 18, carY - 24, 10, 0, Math.PI * 2);
    ctx.arc(carX + 18, carY - 25, 10, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#e04235';
    ctx.beginPath();
    ctx.arc(carX - 54, carY + 6, 5, 0, Math.PI * 2);
    ctx.arc(carX + 54, carY + 6, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (time < 15.6) {
    const localT = time - 7.8;
    const jungleGrad = ctx.createLinearGradient(0, 0, 0, vh);
    jungleGrad.addColorStop(0, '#133a1b');
    jungleGrad.addColorStop(0.7, '#0f2d18');
    jungleGrad.addColorStop(0.75, '#114b4f');
    jungleGrad.addColorStop(1, '#08292e');
    ctx.fillStyle = jungleGrad;
    ctx.fillRect(0, 0, vw, vh);

    for (let i = 0; i < 36; i++) {
      const fx = i < 18 ? (i % 6) * 65 + 20 : vw - ((i % 6) * 65 + 40);
      const fy = Math.floor(i / 6) * 68 + 20;
      ctx.fillStyle = i % 2 === 0 ? '#266b28' : '#388732';
      ctx.beginPath();
      ctx.ellipse(fx, fy, 46, 22, (i % 3) * 0.3 - 0.3, 0, Math.PI * 2);
      ctx.fill();
    }

    const fallGrad = ctx.createLinearGradient(vw * 0.36, 0, vw * 0.56, vh * 0.78);
    fallGrad.addColorStop(0, 'rgba(215, 238, 247, 0.92)');
    fallGrad.addColorStop(0.5, 'rgba(168, 212, 232, 0.85)');
    fallGrad.addColorStop(1, 'rgba(195, 235, 245, 0.95)');
    ctx.fillStyle = fallGrad;
    ctx.fillRect(vw * 0.37, 0, vw * 0.14, vh * 0.76);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.65)';
    ctx.lineWidth = 2;
    for (let s = 0; s < 12; s++) {
      const sx = vw * 0.38 + s * 10;
      const sy = (localT * 180 + s * 47) % (vh * 0.7);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx, sy + 38);
      ctx.stroke();
    }

    const poolGrad = ctx.createLinearGradient(0, vh * 0.75, 0, vh);
    poolGrad.addColorStop(0, '#1e6e75');
    poolGrad.addColorStop(1, '#09343a');
    ctx.fillStyle = poolGrad;
    ctx.fillRect(0, vh * 0.75, vw, vh * 0.25);

    const jumperX = (0.48 + 0.09 * Math.sin(localT * 0.9)) * vw;
    const jumperY = (0.38 + Math.min(0.32, localT * 0.045)) * vh;

    ctx.strokeStyle = '#e0a687';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(jumperX - 16, jumperY - 18, 6, 0, Math.PI * 2);
    ctx.moveTo(jumperX - 16, jumperY - 12);
    ctx.lineTo(jumperX - 12, jumperY + 12);
    ctx.lineTo(jumperX - 22, jumperY + 28);
    ctx.moveTo(jumperX - 14, jumperY - 6);
    ctx.lineTo(jumperX, jumperY - 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(jumperX + 14, jumperY - 14, 6, 0, Math.PI * 2);
    ctx.moveTo(jumperX + 14, jumperY - 8);
    ctx.lineTo(jumperX + 18, jumperY + 16);
    ctx.lineTo(jumperX + 26, jumperY + 32);
    ctx.moveTo(jumperX + 14, jumperY - 2);
    ctx.lineTo(jumperX, jumperY - 2);
    ctx.stroke();
  } else if (time < 22.4) {
    const localT = time - 15.6;
    const bgGrad = ctx.createLinearGradient(0, 0, vw, vh);
    bgGrad.addColorStop(0, '#1b2432');
    bgGrad.addColorStop(0.5, '#2b394f');
    bgGrad.addColorStop(1, '#121822');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, vw, vh);

    const spkX = (0.54 + 0.07 * Math.cos(localT * 1.1)) * vw;
    const spkY = (0.44 + 0.03 * Math.sin(localT * 1.4)) * vh;

    ctx.fillStyle = '#334e68';
    ctx.beginPath();
    ctx.roundRect(spkX - 85, spkY + 42, 170, 160, [48, 48, 0, 0]);
    ctx.fill();

    ctx.fillStyle = '#dfb18b';
    ctx.beginPath();
    ctx.ellipse(spkX, spkY - 4, 42, 52, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const localT = time - 22.4;
    const nightGrad = ctx.createLinearGradient(0, 0, vw, vh);
    nightGrad.addColorStop(0, '#0f172a');
    nightGrad.addColorStop(0.6, '#1e1b4b');
    nightGrad.addColorStop(1, '#311042');
    ctx.fillStyle = nightGrad;
    ctx.fillRect(0, 0, vw, vh);

    const subjX = (0.36 + 0.28 * (localT / 6.6)) * vw;
    const subjY = (0.52 - 0.05 * Math.sin(localT * 1.8)) * vh;

    ctx.fillStyle = '#38bdf8';
    ctx.beginPath();
    ctx.roundRect(subjX - 55, subjY - 28, 110, 56, 16);
    ctx.fill();
  }

  ctx.restore();
}
