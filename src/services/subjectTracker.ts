import { FilesetResolver, ObjectDetector } from '@mediapipe/tasks-vision';
import {
  ObjectTemplateSignature,
  SubjectFocusConfig,
  TrackedObjectPoint,
  TrackingMode,
  TrackingSample,
} from '../types/editor';

export interface FrameSubjectDetection {
  x: number;
  y: number;
  leftSubjectX: number;
  rightSubjectX: number;
  faceX: number;
  faceY: number;
  motionX: number;
  motionY: number;
  confidence: number;
  motionScore: number;
  sceneDelta: number;
  label: string;
}

export interface NeuralObjectBox {
  category: string;
  score: number;
  centerX: number; // 0..1
  centerY: number; // 0..1
  width: number; // 0..1
  height: number; // 0..1
}

// Singleton MediaPipe ObjectDetector instance (EfficientDet-Lite0 WASM/WebGL)
let objectDetectorInstance: ObjectDetector | null = null;
let objectDetectorInitPromise: Promise<ObjectDetector | null> | null = null;

export async function ensureNeuralObjectDetector(): Promise<ObjectDetector | null> {
  if (objectDetectorInstance) return objectDetectorInstance;
  if (objectDetectorInitPromise) return objectDetectorInitPromise;

  objectDetectorInitPromise = (async () => {
    try {
      const vision = await FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
      );
      const detector = await ObjectDetector.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath:
            'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
          delegate: 'GPU',
        },
        scoreThreshold: 0.25,
        runningMode: 'IMAGE',
      });
      objectDetectorInstance = detector;
      return detector;
    } catch (err) {
      console.warn('MediaPipe GPU delegate fallback to CPU:', err);
      try {
        const vision = await FilesetResolver.forVisionTasks(
          'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.18/wasm'
        );
        const detector = await ObjectDetector.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
          },
          scoreThreshold: 0.25,
          runningMode: 'IMAGE',
        });
        objectDetectorInstance = detector;
        return detector;
      } catch (e2) {
        console.warn('Could not load MediaPipe ObjectDetector, using 2D ZNCC + Edge Template tracker:', e2);
        return null;
      }
    }
  })();

  return objectDetectorInitPromise;
}

/**
 * Runs MediaPipe ObjectDetector on a video frame or canvas and returns normalized bounding boxes.
 */
export function detectNeuralObjectsInFrame(
  source: HTMLVideoElement | HTMLCanvasElement,
  frameW: number,
  frameH: number
): NeuralObjectBox[] {
  if (!objectDetectorInstance || frameW <= 0 || frameH <= 0) return [];
  try {
    const result = objectDetectorInstance.detect(source);
    if (!result || !Array.isArray(result.detections)) return [];

    return result.detections
      .map((d) => {
        const bb = d.boundingBox;
        const cat = d.categories?.[0];
        if (!bb || !cat) return null;
        const w = Math.max(0.04, Math.min(0.95, bb.width / frameW));
        const h = Math.max(0.04, Math.min(0.95, bb.height / frameH));
        const cx = Math.max(0.04, Math.min(0.96, (bb.originX + bb.width / 2) / frameW));
        const cy = Math.max(0.04, Math.min(0.96, (bb.originY + bb.height / 2) / frameH));
        return {
          category: cat.categoryName || 'object',
          score: cat.score ?? 0.5,
          centerX: cx,
          centerY: cy,
          width: w,
          height: h,
        };
      })
      .filter((item): item is NeuralObjectBox => item !== null);
  } catch {
    return [];
  }
}

/**
 * Analyzes an HTML5 Canvas image buffer (downsampled e.g. 240x135) using a 12x6 spatial grid
 * to find localized subject clusters (0..1, 0..1).
 */
export function detectFrameSubjectCentroid(
  currData: Uint8ClampedArray,
  prevData: Uint8ClampedArray | null,
  width: number,
  height: number,
  mode: TrackingMode = 'primary-subject'
): FrameSubjectDetection {
  const cols = 12;
  const rows = 6;
  const cellCount = cols * rows;

  const salGrid = new Float32Array(cellCount);
  const skinGrid = new Float32Array(cellCount);
  const motionGrid = new Float32Array(cellCount);

  let totalMotion = 0;
  let totalSceneDelta = 0;
  let skinTotal = 0;
  let motionTotal = 0;

  const pixelCount = Math.max(1, width * height);

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const row = Math.min(rows - 1, Math.floor(ny * rows));
    const verticalPrior = Math.exp(-Math.pow((ny - 0.5) / 0.42, 2));

    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const col = Math.min(cols - 1, Math.floor(nx * cols));
      const cellIdx = row * cols + col;

      const idx = (y * width + x) * 4;
      const r = currData[idx];
      const g = currData[idx + 1];
      const b = currData[idx + 2];

      let motion = 0;
      if (prevData) {
        const dr = Math.abs(r - prevData[idx]);
        const dg = Math.abs(g - prevData[idx + 1]);
        const db = Math.abs(b - prevData[idx + 2]);
        const diff = (dr + dg + db) / (3 * 255);
        totalSceneDelta += diff;
        if (diff > 0.05) {
          motion = Math.pow(diff, 1.25);
          totalMotion += diff;
        }
      }

      const isWarmSkin =
        r > 82 &&
        g > 38 &&
        b > 22 &&
        r > g &&
        r > b &&
        Math.abs(r - g) > 11 &&
        r - b > 16;
      const skinScore = isWarmSkin ? 0.85 : 0;

      let contrast = 0;
      if (x > 0 && x < width - 1) {
        const leftIdx = idx - 4;
        const rightIdx = idx + 4;
        contrast =
          (Math.abs(r - currData[leftIdx]) +
            Math.abs(g - currData[leftIdx + 1]) +
            Math.abs(r - currData[rightIdx])) /
          (3 * 255);
      }

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const saturation = maxC > 25 ? (maxC - minC) / maxC : 0;

      const salWeight =
        (motion * 2.8 + skinScore * 1.9 + contrast * 1.55 + saturation * 0.45) * verticalPrior;
      const faceWeight =
        (skinScore * 2.8 + contrast * 1.1 + motion * 1.2) *
        Math.exp(-Math.pow((ny - 0.38) / 0.28, 2));
      const motWeight = (motion * 3.6 + contrast * 1.4) * verticalPrior;

      salGrid[cellIdx] += salWeight;
      skinGrid[cellIdx] += faceWeight;
      motionGrid[cellIdx] += motWeight;

      skinTotal += skinScore;
      motionTotal += motion;
    }
  }

  const findClusterPeak = (
    grid: Float32Array,
    minCol: number,
    maxCol: number,
    defaultX: number,
    defaultY: number
  ): { x: number; y: number; strength: number } => {
    let bestCol = Math.round((minCol + maxCol) / 2);
    let bestRow = 2;
    let bestScore = -1;

    for (let r = 0; r < rows; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        let sum = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const nr = r + dr;
            const nc = c + dc;
            if (nr >= 0 && nr < rows && nc >= minCol && nc <= maxCol) {
              const kernelW = dr === 0 && dc === 0 ? 2.0 : 1.0;
              sum += grid[nr * cols + nc] * kernelW;
            }
          }
        }
        if (sum > bestScore) {
          bestScore = sum;
          bestCol = c;
          bestRow = r;
        }
      }
    }

    if (bestScore <= 0.01) {
      return { x: defaultX, y: defaultY, strength: 0 };
    }

    let wx = 0;
    let wy = 0;
    let wt = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = bestRow + dr;
        const nc = bestCol + dc;
        if (nr >= 0 && nr < rows && nc >= minCol && nc <= maxCol) {
          const val = Math.pow(Math.max(0, grid[nr * cols + nc]), 1.6);
          const cellCenterX = (nc + 0.5) / cols;
          const cellCenterY = (nr + 0.5) / rows;
          wx += cellCenterX * val;
          wy += cellCenterY * val;
          wt += val;
        }
      }
    }

    const cx = wt > 0 ? wx / wt : defaultX;
    const cy = wt > 0 ? wy / wt : defaultY;
    return {
      x: Math.max(0.08, Math.min(0.92, cx)),
      y: Math.max(0.15, Math.min(0.85, cy)),
      strength: bestScore,
    };
  };

  const primaryCluster = findClusterPeak(salGrid, 0, cols - 1, 0.5, 0.48);
  const leftCluster = findClusterPeak(salGrid, 0, Math.floor(cols / 2) - 1, 0.3, 0.48);
  const rightCluster = findClusterPeak(salGrid, Math.floor(cols / 2), cols - 1, 0.7, 0.48);
  const faceCluster = findClusterPeak(skinGrid, 0, cols - 1, primaryCluster.x, 0.42);
  const motionCluster = findClusterPeak(motionGrid, 0, cols - 1, primaryCluster.x, 0.5);

  let chosenX = primaryCluster.x;
  let chosenY = primaryCluster.y;
  if (mode === 'center-lock') {
    chosenX = 0.5;
    chosenY = 0.5;
  } else if (mode === 'face-speaker') {
    chosenX = faceCluster.x;
    chosenY = faceCluster.y;
  } else if (mode === 'action-motion') {
    chosenX = motionCluster.x;
    chosenY = motionCluster.y;
  }

  const motionScore = Math.min(100, Math.round((totalMotion / pixelCount) * 950));
  const sceneDelta = totalSceneDelta / pixelCount;
  const confidence = Math.max(
    0.65,
    Math.min(0.99, 0.68 + (motionTotal + skinTotal) / (pixelCount * 0.45))
  );

  const label =
    skinTotal > motionTotal * 1.2
      ? 'Speaker / Face'
      : motionScore > 22
        ? 'Moving Subject'
        : 'Salient Subject';

  return {
    x: Number(chosenX.toFixed(4)),
    y: Number(chosenY.toFixed(4)),
    leftSubjectX: Number(Math.max(0.08, Math.min(0.48, leftCluster.x)).toFixed(4)),
    rightSubjectX: Number(Math.max(0.52, Math.min(0.92, rightCluster.x)).toFixed(4)),
    faceX: Number(faceCluster.x.toFixed(4)),
    faceY: Number(faceCluster.y.toFixed(4)),
    motionX: Number(motionCluster.x.toFixed(4)),
    motionY: Number(motionCluster.y.toFixed(4)),
    confidence: Number(confidence.toFixed(2)),
    motionScore,
    sceneDelta,
    label,
  };
}

let liveTrackCanvas: HTMLCanvasElement | null = null;
let liveTrackCtx: CanvasRenderingContext2D | null = null;

function getLiveTrackContext(w = 240, h = 135): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!liveTrackCanvas || liveTrackCanvas.width !== w || liveTrackCanvas.height !== h) {
    liveTrackCanvas = document.createElement('canvas');
    liveTrackCanvas.width = w;
    liveTrackCanvas.height = h;
    liveTrackCtx = liveTrackCanvas.getContext('2d', { willReadFrequently: true });
  }
  return liveTrackCtx;
}

/**
 * Extracts a 13x13 2D Spatial Template Patch:
 * - Zero-Mean Unit-Norm Luminance vector (`lumaPatch`) for true [-1, +1] ZNCC
 * - Unit-Norm Sobel Edge Gradient vector (`edgePatch`) for true [0, +1] cosine shape matching
 * - Per-pixel RGB layout (`rgbPatch`) so top/bottom/center color arrangement is preserved
 * - Internal Contrast Standard Deviation (`contrastStd`), Mean Edge Energy (`edgeEnergy`),
 *   and 15th/85th percentile luminances (`p15Luma`, `p85Luma`, `dynamicRange`) to distinguish
 *   solid rigid objects (car with dark windows/wheels + bright body) from empty black sky and white smoke!
 */
function extractPatchFeaturesAt(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  normX: number,
  normY: number,
  patchSize = 13,
  stepPx = 2
): {
  lumaPatch: number[];
  edgePatch: number[];
  rgbPatch: number[];
  meanRgb: [number, number, number];
  contrastStd: number;
  edgeEnergy: number;
  meanLuma: number;
  p15Luma: number;
  p85Luma: number;
  dynamicRange: number;
  topHalfLuma: number;
  bottomHalfLuma: number;
} {
  const half = Math.floor(patchSize / 2);
  const cx = Math.max(half * stepPx + 1, Math.min(w - half * stepPx - 2, Math.round(normX * w)));
  const cy = Math.max(half * stepPx + 1, Math.min(h - half * stepPx - 2, Math.round(normY * h)));

  const rawLuma: number[] = [];
  const rawEdge: number[] = [];
  const rgbPatch: number[] = [];
  const hist = new Int32Array(32);
  let rSum = 0;
  let gSum = 0;
  let bSum = 0;
  let lumaSum = 0;
  let edgeSum = 0;
  let edgeSqSum = 0;
  let topLumaSum = 0;
  let topCount = 0;
  let bottomLumaSum = 0;
  let bottomCount = 0;

  const getLuma = (px: number, py: number) => {
    const idx = (py * w + px) * 4;
    return (0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]) / 255;
  };

  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const px = cx + dx * stepPx;
      const py = cy + dy * stepPx;
      const idx = (py * w + px) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      rSum += r;
      gSum += g;
      bSum += b;
      rgbPatch.push(r, g, b);

      const l = getLuma(px, py);
      rawLuma.push(l);
      lumaSum += l;
      if (dy < 0) {
        topLumaSum += l;
        topCount++;
      } else if (dy > 0) {
        bottomLumaSum += l;
        bottomCount++;
      }
      const bin = Math.max(0, Math.min(31, Math.floor(l * 31.99)));
      hist[bin]++;

      // Sobel-like horizontal + vertical gradient magnitude
      const gx = getLuma(px + 1, py) - getLuma(px - 1, py);
      const gy = getLuma(px, py + 1) - getLuma(px, py - 1);
      const grad = Math.min(1, Math.hypot(gx, gy) * 2.5);
      rawEdge.push(grad);
      edgeSum += grad;
      edgeSqSum += grad * grad;
    }
  }

  const n = rawLuma.length;
  const meanL = lumaSum / Math.max(1, n);
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const diff = rawLuma[i] - meanL;
    varSum += diff * diff;
  }
  const stdL = Math.sqrt(varSum / Math.max(1, n));

  // Prevent amplifying 1-bit compression noise in pitch-black sky by enforcing a realistic minimum norm floor
  const lumaNorm = Math.max(0.18, Math.sqrt(varSum));
  const lumaPatch = rawLuma.map((v) => Number(((v - meanL) / lumaNorm).toFixed(5)));

  const edgeNorm = Math.max(0.18, Math.sqrt(edgeSqSum));
  const edgePatch = rawEdge.map((e) => Number((e / edgeNorm).toFixed(5)));

  // Fast percentile extraction from 32-bin histogram
  const p15Target = Math.max(1, Math.round(n * 0.15));
  const p85Target = Math.max(1, Math.round(n * 0.85));
  let cum = 0;
  let p15Luma = 0;
  let p85Luma = 0;
  let found15 = false;
  let found85 = false;
  for (let b = 0; b < 32; b++) {
    cum += hist[b];
    if (!found15 && cum >= p15Target) {
      p15Luma = (b + 0.5) / 32;
      found15 = true;
    }
    if (!found85 && cum >= p85Target) {
      p85Luma = (b + 0.5) / 32;
      found85 = true;
      break;
    }
  }

  return {
    lumaPatch,
    edgePatch,
    rgbPatch,
    meanRgb: [Math.round(rSum / n), Math.round(gSum / n), Math.round(bSum / n)],
    contrastStd: Number(stdL.toFixed(4)),
    edgeEnergy: Number((edgeSum / Math.max(1, n)).toFixed(4)),
    meanLuma: Number(meanL.toFixed(4)),
    p15Luma: Number(p15Luma.toFixed(4)),
    p85Luma: Number(p85Luma.toFixed(4)),
    dynamicRange: Number(Math.max(0, p85Luma - p15Luma).toFixed(4)),
    topHalfLuma: Number((topLumaSum / Math.max(1, topCount)).toFixed(4)),
    bottomHalfLuma: Number((bottomLumaSum / Math.max(1, bottomCount)).toFixed(4)),
  };
}

/**
 * Captures the complete 2D Object Template Signature + Neural Object Detector category when the user
 * clicks on any object in the video at `(normX, normY)`.
 */
export function captureClickedObjectSignature(
  videoEl: HTMLVideoElement | null,
  normX: number,
  normY: number
): {
  refinedX: number;
  refinedY: number;
  targetColorRgb?: [number, number, number];
  templateSignature?: ObjectTemplateSignature;
  detectedLabel: string;
} {
  if (!videoEl || videoEl.readyState < 2) {
    return {
      refinedX: normX,
      refinedY: normY,
      detectedLabel: `Tracked Object (${Math.round(normX * 100)}%, ${Math.round(normY * 100)}%)`,
    };
  }

  const w = 240;
  const h = 135;
  const ctx = getLiveTrackContext(w, h);
  if (!ctx) {
    return {
      refinedX: normX,
      refinedY: normY,
      detectedLabel: `Tracked Object (${Math.round(normX * 100)}%, ${Math.round(normY * 100)}%)`,
    };
  }

  ensureNeuralObjectDetector().catch(() => {});

  try {
    ctx.drawImage(videoEl, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    // 1. Check if MediaPipe Neural ObjectDetector finds a bounding box on the full-res video element
    const vw = videoEl.videoWidth || w;
    const vh = videoEl.videoHeight || h;
    const neuralBoxes = detectNeuralObjectsInFrame(videoEl, vw, vh);
    let matchedNeural: NeuralObjectBox | null = null;
    let bestNeuralDist = 0.16;

    for (const box of neuralBoxes) {
      const insideX = Math.abs(normX - box.centerX) <= box.width * 0.6;
      const insideY = Math.abs(normY - box.centerY) <= box.height * 0.6;
      const dist = Math.hypot(normX - box.centerX, normY - box.centerY);
      if ((insideX && insideY && dist < bestNeuralDist * 1.35) || dist < bestNeuralDist) {
        bestNeuralDist = dist;
        matchedNeural = box;
      }
    }

    // Also snap within ±5% around the user's click to the strongest rigid-object core so slightly off-center clicks still lock cleanly
    let refinedX = matchedNeural ? matchedNeural.centerX * 0.3 + normX * 0.7 : normX;
    let refinedY = matchedNeural ? matchedNeural.centerY * 0.3 + normY * 0.7 : normY;

    const patchSize = 13;
    const feat = extractPatchFeaturesAt(data, w, h, refinedX, refinedY, patchSize, 2);

    const boxW = matchedNeural ? Math.max(0.08, Math.min(0.32, matchedNeural.width)) : 0.14;
    const boxH = matchedNeural ? Math.max(0.08, Math.min(0.32, matchedNeural.height)) : 0.14;
    const catName = matchedNeural?.category;

    const templateSignature: ObjectTemplateSignature = {
      patchSize,
      lumaPatch: feat.lumaPatch,
      edgePatch: feat.edgePatch,
      rgbPatch: feat.rgbPatch,
      meanRgb: feat.meanRgb,
      contrastStd: feat.contrastStd,
      edgeEnergy: feat.edgeEnergy,
      detectedCategory: catName,
      boxW,
      boxH,
    };

    const detectedLabel = catName
      ? `Tracked ${catName.toUpperCase()} (${Math.round(refinedX * 100)}%, ${Math.round(refinedY * 100)}%)`
      : `Tracked Object (${Math.round(refinedX * 100)}%, ${Math.round(refinedY * 100)}%)`;

    return {
      refinedX: Number(refinedX.toFixed(4)),
      refinedY: Number(refinedY.toFixed(4)),
      targetColorRgb: feat.meanRgb,
      templateSignature,
      detectedLabel,
    };
  } catch {
    return {
      refinedX: normX,
      refinedY: normY,
      detectedLabel: `Tracked Object (${Math.round(normX * 100)}%, ${Math.round(normY * 100)}%)`,
    };
  }
}

export function sampleSubjectSignatureFromVideo(
  videoEl: HTMLVideoElement | null,
  normX: number,
  normY: number
): [number, number, number] | undefined {
  return captureClickedObjectSignature(videoEl, normX, normY).targetColorRgb;
}

/**
 * Evaluates both Template Similarity AND Rigid Foreground Object Quality [0..1] at `(candNormX, candNormY)`:
 * 1. HARD REJECTION of empty dark sky / flat background (`p85Luma < 0.14` or `contrastStd < 0.032` or `edgeEnergy < 0.03` -> returns 0!).
 * 2. SMOKE / CLOUD REJECTION: Pure white/grey smoke has high `p15Luma` (> 0.34) because it has no dark windows, wheels, or shadow core.
 *    Solid objects (like the car!) have BOTH dark structural features (`p15Luma < 0.28`) AND bright surfaces (`p85Luma > 0.25`) + sharp Sobel edges!
 * 3. 2D Template Match (Per-pixel RGB + Unit-norm Luminance ZNCC + Unit-norm Sobel Edge cosine).
 */
function scoreCandidatePatch(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  candNormX: number,
  candNormY: number,
  templateSig?: ObjectTemplateSignature,
  fallbackRgb?: [number, number, number]
): number {
  const patchSize = templateSig?.patchSize || 13;
  const stepPx = 2;
  const cand = extractPatchFeaturesAt(data, w, h, candNormX, candNormY, patchSize, stepPx);

  // 1. HARD FOREGROUND GATE: Never allow the tracker to sit in empty black sky or flat dark pavement!
  if (cand.p85Luma < 0.14 || cand.contrastStd < 0.032 || cand.edgeEnergy < 0.028) {
    return 0;
  }

  // 2. Reject Sky-to-Smoke Borders: if the top half or bottom half of the patch is pitch-black empty sky/ground
  // (< 6.5% brightness), this point is sitting on the outer boundary of a smoke cloud against the black sky, NOT centered on the car!
  const skyBorderPenalty =
    cand.topHalfLuma < 0.065 || cand.bottomHalfLuma < 0.065 ? 0.16 : 1.0;

  // 3. Rigid Structured Object Score vs. Diffuse White Smoke Rejection:
  // A solid vehicle/subject has dark structural features (tinted windows, tires, shadow core: p15Luma < 0.24)
  // right next to lit body panels (p85Luma > 0.25), creating high dynamicRange and sharp edges.
  // Pure billowing white smoke has NO dark structural core (p15Luma > 0.30).
  const hasDarkStructuralCore =
    cand.p15Luma < 0.24 ? 1.0 : Math.max(0.12, 1.0 - (cand.p15Luma - 0.24) * 3.8);
  const dynamicRangeScore = Math.min(1.0, cand.dynamicRange / 0.38);
  const edgeStrengthScore = Math.min(1.0, cand.edgeEnergy / 0.18);
  const rigidObjectScore =
    (dynamicRangeScore * 0.45 + edgeStrengthScore * 0.55) *
    hasDarkStructuralCore *
    skyBorderPenalty;

  const [tr, tg, tb] = templateSig?.meanRgb || fallbackRgb || [200, 200, 200];

  // 4. Per-pixel 2D RGB layout match (or mean RGB fallback)
  let colorSim = 0;
  if (templateSig?.rgbPatch && templateSig.rgbPatch.length === cand.rgbPatch.length) {
    const refRgb = templateSig.rgbPatch;
    let diffSum = 0;
    for (let i = 0; i < refRgb.length; i++) {
      diffSum += Math.abs(refRgb[i] - cand.rgbPatch[i]);
    }
    const meanDiff = diffSum / (refRgb.length * 255);
    colorSim = Math.max(0, 1 - meanDiff * 2.4);
  } else {
    const rgbDist =
      (Math.abs(cand.meanRgb[0] - tr) +
        Math.abs(cand.meanRgb[1] - tg) +
        Math.abs(cand.meanRgb[2] - tb)) /
      (3 * 255);
    colorSim = Math.max(0, 1 - rgbDist * 2.2);
  }

  // 5. Unit-norm Zero-Mean Normalized Cross-Correlation (ZNCC) & Cosine Edge Correlation
  let lumaZncc = 0;
  let edgeCosine = 0;
  const refLuma = templateSig?.lumaPatch;
  const refEdge = templateSig?.edgePatch;
  if (refLuma && refEdge && refLuma.length === cand.lumaPatch.length) {
    for (let i = 0; i < refLuma.length; i++) {
      lumaZncc += refLuma[i] * cand.lumaPatch[i];
      edgeCosine += refEdge[i] * cand.edgePatch[i];
    }
  }

  const templateSim =
    colorSim * 0.34 +
    Math.max(0, (lumaZncc + 1) * 0.5) * 0.30 +
    Math.max(0, edgeCosine) * 0.36;

  // Fuse Template Similarity (50%) with Rigid Object Structure (50%) so even when lighting/angle shifts
  // or smoke surrounds the car, the tracker stays locked on the rigid car body and rejects both sky and smoke!
  const combined =
    (templateSim * 0.5 + rigidObjectScore * 0.5) * hasDarkStructuralCore * skyBorderPenalty;
  return combined;
}

/**
 * Blends an existing ObjectTemplateSignature with a newly observed high-confidence frame patch
 * so the tracker adapts smoothly as an object turns, flies, or changes lighting across shots.
 */
function adaptTemplateSignature(
  oldSig: ObjectTemplateSignature | undefined,
  data: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
  alpha = 0.18
): ObjectTemplateSignature | undefined {
  if (!oldSig) return undefined;
  const feat = extractPatchFeaturesAt(data, w, h, x, y, oldSig.patchSize || 13, 2);
  if (feat.p85Luma < 0.16 || feat.contrastStd < 0.035) return oldSig;

  const blendArr = (a: number[], b: number[]) =>
    a.length === b.length
      ? a.map((v, i) => Number((v * (1 - alpha) + b[i] * alpha).toFixed(5)))
      : a;

  return {
    ...oldSig,
    lumaPatch: blendArr(oldSig.lumaPatch, feat.lumaPatch),
    edgePatch: blendArr(oldSig.edgePatch, feat.edgePatch),
    rgbPatch: oldSig.rgbPatch ? blendArr(oldSig.rgbPatch, feat.rgbPatch) : feat.rgbPatch,
    meanRgb: [
      Math.round(oldSig.meanRgb[0] * (1 - alpha) + feat.meanRgb[0] * alpha),
      Math.round(oldSig.meanRgb[1] * (1 - alpha) + feat.meanRgb[1] * alpha),
      Math.round(oldSig.meanRgb[2] * (1 - alpha) + feat.meanRgb[2] * alpha),
    ],
    contrastStd: Number((oldSig.contrastStd * (1 - alpha) + feat.contrastStd * alpha).toFixed(4)),
    edgeEnergy: Number(
      ((oldSig.edgeEnergy ?? feat.edgeEnergy) * (1 - alpha) + feat.edgeEnergy * alpha).toFixed(4)
    ),
  };
}

/**
 * Core 3-Layer Object Tracker on a single frame:
 * Combines:
 * 1. Empty-Sky / Background Gate + Stationary Lock check
 * 2. Automatic Wide Re-Acquisition if the object jumped or camera cut to a new shot
 * 3. MediaPipe Neural Object Detection bounding-box matching
 * 4. Rigid Object Structure (dark windows/wheels + bright body + sharp edges) vs. White Smoke rejection
 */
export function trackObjectInFrameBuffer(
  data: Uint8ClampedArray,
  canvasEl: HTMLCanvasElement | null,
  w: number,
  h: number,
  prevX: number,
  prevY: number,
  velX: number,
  velY: number,
  templateSig?: ObjectTemplateSignature,
  fallbackRgb?: [number, number, number],
  prevFrameData?: Uint8ClampedArray | null
): {
  x: number;
  y: number;
  vx: number;
  vy: number;
  boxW: number;
  boxH: number;
  confidence: number;
  adaptedTemplate?: ObjectTemplateSignature;
} {
  let boxW = templateSig?.boxW ?? 0.14;
  let boxH = templateSig?.boxH ?? 0.14;

  // 0. Evaluate appearance at the current position (prevX, prevY)
  const stayAppearance = scoreCandidatePatch(
    data,
    w,
    h,
    prevX,
    prevY,
    templateSig,
    fallbackRgb
  );

  // Stationary Lock: if the object is still right at (prevX, prevY) with strong appearance and minimal pixel change, hold steady
  if (prevFrameData && prevFrameData.length === data.length && stayAppearance >= 0.52) {
    const halfW = Math.max(6, Math.round(w * 0.05));
    const halfH = Math.max(6, Math.round(h * 0.05));
    const cx = Math.round(prevX * w);
    const cy = Math.round(prevY * h);
    let localDiffSum = 0;
    let count = 0;
    for (let y = Math.max(0, cy - halfH); y <= Math.min(h - 1, cy + halfH); y += 2) {
      for (let x = Math.max(0, cx - halfW); x <= Math.min(w - 1, cx + halfW); x += 2) {
        const idx = (y * w + x) * 4;
        localDiffSum +=
          (Math.abs(data[idx] - prevFrameData[idx]) +
            Math.abs(data[idx + 1] - prevFrameData[idx + 1]) +
            Math.abs(data[idx + 2] - prevFrameData[idx + 2])) /
          (3 * 255);
        count++;
      }
    }
    const localDiff = count > 0 ? localDiffSum / count : 1;
    if (localDiff < 0.02 && stayAppearance >= 0.58) {
      return {
        x: Number(prevX.toFixed(4)),
        y: Number(prevY.toFixed(4)),
        vx: 0,
        vy: 0,
        boxW: Number(boxW.toFixed(4)),
        boxH: Number(boxH.toFixed(4)),
        confidence: Number(Math.min(0.99, stayAppearance).toFixed(2)),
        adaptedTemplate: templateSig,
      };
    }
  }

  // If stayAppearance is low (< 0.36), (prevX, prevY) is in empty sky, background, or a new camera cut!
  // Automatically widen the search window across the frame to re-acquire the car/object!
  const needsWideReacquire = stayAppearance < 0.36;

  const predX = needsWideReacquire
    ? 0.5
    : Math.max(0.06, Math.min(0.94, prevX + velX));
  const predY = needsWideReacquire
    ? 0.58
    : Math.max(0.08, Math.min(0.92, prevY + velY));

  // 1. Check MediaPipe Neural ObjectDetector if available
  let neuralCandidate: NeuralObjectBox | null = null;
  if (canvasEl && objectDetectorInstance) {
    const detections = detectNeuralObjectsInFrame(canvasEl, w, h);
    let bestScore = -1;
    for (const det of detections) {
      const maxDist = needsWideReacquire ? 0.65 : 0.32;
      const dist = Math.hypot(det.centerX - predX, det.centerY - predY);
      if (dist > maxDist) continue;
      const catBonus =
        templateSig?.detectedCategory && det.category === templateSig.detectedCategory
          ? 0.25
          : 0;
      const proximityScore = Math.exp(-dist * (needsWideReacquire ? 1.8 : 4.2));
      const combined = (det.score + catBonus) * proximityScore;
      if (combined > bestScore) {
        bestScore = combined;
        neuralCandidate = det;
      }
    }
  }

  // 2. Search window: focused (±22% X, ±16% Y) during continuous tracking, or wide (80% of frame) when re-acquiring!
  const searchRadX = Math.round(w * (needsWideReacquire ? 0.42 : 0.22));
  const searchRadY = Math.round(h * (needsWideReacquire ? 0.34 : 0.16));
  const centerPx = Math.round(predX * w);
  const centerPy = Math.round(predY * h);

  const patchSize = templateSig?.patchSize || 13;
  const stepPx = 2;
  const margin = Math.floor(patchSize / 2) * stepPx + 2;

  const minPx = Math.max(margin, centerPx - searchRadX);
  const maxPx = Math.min(w - margin - 1, centerPx + searchRadX);
  const minPy = Math.max(margin, centerPy - searchRadY);
  const maxPy = Math.min(h - margin - 1, centerPy + searchRadY);

  let bestX = prevX;
  let bestY = prevY;
  let bestAppearance = stayAppearance;
  let bestTotalScore = stayAppearance;

  const stride = needsWideReacquire ? 4 : 3;
  const priorDecay = needsWideReacquire ? 1.1 : 2.6;

  for (let py = minPy; py <= maxPy; py += stride) {
    for (let px = minPx; px <= maxPx; px += stride) {
      const candNormX = px / w;
      const candNormY = py / h;

      // During wide re-acquisition, ignore top corner watermarks (e.g. X/@Tesla) and extreme edges
      if (
        needsWideReacquire &&
        (candNormY < 0.22 || candNormY > 0.86 || candNormX < 0.1 || candNormX > 0.86)
      ) {
        continue;
      }

      const appScore = scoreCandidatePatch(
        data,
        w,
        h,
        candNormX,
        candNormY,
        templateSig,
        fallbackRgb
      );
      if (appScore <= 0.01) continue;

      // Active motion bonus if previous frame buffer is available
      let motionBonus = 0;
      if (prevFrameData && prevFrameData.length === data.length) {
        const idx = (py * w + px) * 4;
        const mDiff =
          (Math.abs(data[idx] - prevFrameData[idx]) +
            Math.abs(data[idx + 1] - prevFrameData[idx + 1]) +
            Math.abs(data[idx + 2] - prevFrameData[idx + 2])) /
          (3 * 255);
        if (mDiff > 0.04) {
          motionBonus = Math.min(0.14, mDiff * 0.45);
        }
      }

      const distFromPred = Math.hypot(candNormX - predX, candNormY - predY);
      const motionPrior = Math.exp(-distFromPred * priorDecay);

      let neuralBonus = 0;
      if (neuralCandidate) {
        const dNeural = Math.hypot(
          candNormX - neuralCandidate.centerX,
          candNormY - neuralCandidate.centerY
        );
        if (dNeural < 0.14) {
          neuralBonus = 0.22 * Math.exp(-dNeural * 8);
        }
      }

      const totalScore = (appScore + motionBonus + neuralBonus) * motionPrior;

      if (totalScore > bestTotalScore) {
        bestTotalScore = totalScore;
        bestAppearance = appScore;
        bestX = candNormX;
        bestY = candNormY;
      }
    }
  }

  // Fine 1px refinement + 5x5 Weighted Sub-Pixel Centroid around best coarse location (eliminates grid-step jitter!)
  const winPx = Math.round(bestX * w);
  const winPy = Math.round(bestY * h);
  let sumWx = 0;
  let sumWy = 0;
  let sumW = 0;

  for (let py = Math.max(margin, winPy - 2); py <= Math.min(h - margin - 1, winPy + 2); py++) {
    for (let px = Math.max(margin, winPx - 2); px <= Math.min(w - margin - 1, winPx + 2); px++) {
      const candNormX = px / w;
      const candNormY = py / h;
      const appScore = scoreCandidatePatch(
        data,
        w,
        h,
        candNormX,
        candNormY,
        templateSig,
        fallbackRgb
      );
      if (appScore <= 0.01) continue;
      const distFromPred = Math.hypot(candNormX - predX, candNormY - predY);
      const motionPrior = Math.exp(-distFromPred * priorDecay);
      const totalScore = appScore * motionPrior;
      if (totalScore > bestTotalScore) {
        bestTotalScore = totalScore;
        bestAppearance = appScore;
        bestX = candNormX;
        bestY = candNormY;
      }
      if (totalScore > stayAppearance * 0.85) {
        const wgt = Math.pow(Math.max(0.001, totalScore), 4);
        sumWx += candNormX * wgt;
        sumWy += candNormY * wgt;
        sumW += wgt;
      }
    }
  }

  if (sumW > 0) {
    bestX = bestX * 0.4 + (sumWx / sumW) * 0.6;
    bestY = bestY * 0.4 + (sumWy / sumW) * 0.6;
  }

  // Fuse neural bounding box center if neural detector had a lock
  if (
    neuralCandidate &&
    neuralCandidate.score >= 0.42 &&
    Math.hypot(neuralCandidate.centerX - bestX, neuralCandidate.centerY - bestY) < 0.18
  ) {
    bestX = bestX * 0.6 + neuralCandidate.centerX * 0.4;
    bestY = bestY * 0.6 + neuralCandidate.centerY * 0.4;
    boxW = Math.max(0.08, Math.min(0.32, neuralCandidate.width));
    boxH = Math.max(0.08, Math.min(0.32, neuralCandidate.height));
  }

  // Steadicam-style Deadzone + Damped Kalman Filter (eliminates high-frequency jitter!)
  const deltaX = bestX - prevX;
  const deltaY = bestY - prevY;
  const moveDist = Math.hypot(deltaX, deltaY);

  // Micro-jitter deadzone: movements smaller than 1.0% of frame are heavily damped
  let gain = 0.24;
  if (needsWideReacquire && stayAppearance < 0.08) {
    gain = 0.65;
  } else if (moveDist < 0.012) {
    gain = 0.06;
  } else if (moveDist < 0.03) {
    gain = 0.16;
  } else {
    gain = 0.28;
  }

  const nextX = Math.max(0.06, Math.min(0.94, prevX + deltaX * gain));
  const nextY = Math.max(0.1, Math.min(0.9, prevY + deltaY * gain));
  const nextVx = needsWideReacquire
    ? 0
    : Math.max(-0.04, Math.min(0.04, velX * 0.65 + (nextX - prevX) * 0.35));
  const nextVy = needsWideReacquire
    ? 0
    : Math.max(-0.03, Math.min(0.03, velY * 0.65 + (nextY - prevY) * 0.35));

  const adaptedTemplate =
    bestAppearance >= 0.48
      ? adaptTemplateSignature(templateSig, data, w, h, nextX, nextY, 0.12)
      : templateSig;

  return {
    x: Number(nextX.toFixed(4)),
    y: Number(nextY.toFixed(4)),
    vx: Number(nextVx.toFixed(4)),
    vy: Number(nextVy.toFixed(4)),
    boxW: Number(boxW.toFixed(4)),
    boxH: Number(boxH.toFixed(4)),
    confidence: Number(Math.max(0.55, Math.min(0.99, bestAppearance)).toFixed(2)),
    adaptedTemplate,
  };
}

/**
 * Evaluates a natural, monotone Cubic Hermite / Smoothstep Spline through user-placed Focus Lock Points (`isUserAnchor: true`).
 * When the user clicks at 2 or more points along the timeline, this strings them together into a silky-smooth,
 * zero-jitter camera transition!
 */
export function evaluateUserAnchorSplineAtTime(
  trackedPath: TrackedObjectPoint[] | undefined,
  time: number
): {
  x: number;
  y: number;
  isBetweenUserAnchors: boolean;
  userAnchorCount: number;
} | null {
  if (!trackedPath || trackedPath.length === 0) return null;
  const anchors = trackedPath
    .filter((p) => p.isUserAnchor)
    .sort((a, b) => a.time - b.time);

  if (anchors.length === 0) return null;
  if (anchors.length === 1) {
    return {
      x: anchors[0].x,
      y: anchors[0].y,
      isBetweenUserAnchors: Math.abs(time - anchors[0].time) < 0.08,
      userAnchorCount: 1,
    };
  }

  // Before first Focus Lock Point: hold smoothly at the first lock point
  if (time <= anchors[0].time) {
    return {
      x: anchors[0].x,
      y: anchors[0].y,
      isBetweenUserAnchors: true,
      userAnchorCount: anchors.length,
    };
  }

  // After last Focus Lock Point: return last lock point (caller can either hold or gently vision-assist from here)
  const lastIdx = anchors.length - 1;
  if (time >= anchors[lastIdx].time) {
    return {
      x: anchors[lastIdx].x,
      y: anchors[lastIdx].y,
      isBetweenUserAnchors: false,
      userAnchorCount: anchors.length,
    };
  }

  // Find segment [i, i+1] containing `time`
  let segIdx = 0;
  for (let i = 0; i < lastIdx; i++) {
    if (time >= anchors[i].time && time <= anchors[i + 1].time) {
      segIdx = i;
      break;
    }
  }

  const p1 = anchors[segIdx];
  const p2 = anchors[segIdx + 1];
  const dt = Math.max(0.001, p2.time - p1.time);
  const u = Math.max(0, Math.min(1, (time - p1.time) / dt));

  // If only 2 points total, use a natural Cosine / Quintic S-curve (ease-in-out)
  if (anchors.length === 2) {
    const s = u * u * u * (u * (u * 6 - 15) + 10); // Quintic smoothstep (zero acceleration at both ends)
    return {
      x: Number((p1.x + (p2.x - p1.x) * s).toFixed(4)),
      y: Number((p1.y + (p2.y - p1.y) * s).toFixed(4)),
      isBetweenUserAnchors: true,
      userAnchorCount: 2,
    };
  }

  // For 3+ points, use Monotone Cubic Hermite Spline (Fritsch-Carlson tangent clamping so it never overshoots!)
  const evalMonotoneHermite = (coord: 'x' | 'y'): number => {
    const p0 = anchors[Math.max(0, segIdx - 1)];
    const p3 = anchors[Math.min(lastIdx, segIdx + 2)];

    const secant1 = (p2[coord] - p1[coord]) / dt;
    const secant0 =
      segIdx > 0
        ? (p1[coord] - p0[coord]) / Math.max(0.001, p1.time - p0.time)
        : secant1;
    const secant2 =
      segIdx + 1 < lastIdx
        ? (p3[coord] - p2[coord]) / Math.max(0.001, p3.time - p2.time)
        : secant1;

    let m1 = (secant0 + secant1) * 0.5;
    let m2 = (secant1 + secant2) * 0.5;

    // Enforce monotonicity (zero overshoot if direction reverses or stays flat)
    if (secant0 * secant1 <= 0) m1 = 0;
    if (secant1 * secant2 <= 0) m2 = 0;
    if (Math.abs(secant1) < 1e-5) {
      m1 = 0;
      m2 = 0;
    } else {
      const maxSlope = Math.abs(secant1) * 2.5;
      m1 = Math.max(-maxSlope, Math.min(maxSlope, m1));
      m2 = Math.max(-maxSlope, Math.min(maxSlope, m2));
    }

    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;

    return h00 * p1[coord] + h10 * dt * m1 + h01 * p2[coord] + h11 * dt * m2;
  };

  return {
    x: Number(Math.max(0.06, Math.min(0.94, evalMonotoneHermite('x'))).toFixed(4)),
    y: Number(Math.max(0.1, Math.min(0.9, evalMonotoneHermite('y'))).toFixed(4)),
    isBetweenUserAnchors: true,
    userAnchorCount: anchors.length,
  };
}

/**
 * Generates a dense array of points along the smooth User Focus Lock Spline for clean UI visualization
 * AND preserves every user anchor (`isUserAnchor: true`) so `trackedPath` never loses user lock points!
 */
export function buildSmoothUserAnchorCurvePoints(
  trackedPath: TrackedObjectPoint[] | undefined,
  samplesCount = 48
): TrackedObjectPoint[] {
  if (!trackedPath) return [];
  const anchors = trackedPath
    .filter((p) => p.isUserAnchor)
    .sort((a, b) => a.time - b.time);
  if (anchors.length === 0) return [];
  if (anchors.length === 1) return [...anchors];

  const tStart = anchors[0].time;
  const tEnd = anchors[anchors.length - 1].time;
  if (tEnd <= tStart + 0.01) return [...anchors];

  const sampled: TrackedObjectPoint[] = [];
  for (let i = 0; i <= samplesCount; i++) {
    const t = Number((tStart + ((tEnd - tStart) * i) / samplesCount).toFixed(2));
    // Skip sample if it's right on top of an explicit user anchor (we merge exact user anchors below)
    if (anchors.some((a) => Math.abs(a.time - t) < 0.04)) continue;
    const sp = evaluateUserAnchorSplineAtTime(anchors, t);
    if (sp) {
      sampled.push({
        x: sp.x,
        y: sp.y,
        time: t,
        boxW: anchors[0].boxW ?? 0.14,
        boxH: anchors[0].boxH ?? 0.16,
        confidence: 0.99,
      });
    }
  }
  return [...anchors, ...sampled].sort((a, b) => a.time - b.time);
}

// Persistent state for real-time 60fps playback & live seek object tracking on the visible <video> element
let liveVelocity = { vx: 0, vy: 0, lastTime: -1 };
let liveSmoothPos: { x: number; y: number } | null = null;
let livePrevFrameData: Uint8ClampedArray | null = null;
let liveRunningTemplate: ObjectTemplateSignature | undefined = undefined;

export function resetLiveObjectTrackerState(
  initialTemplate?: ObjectTemplateSignature,
  initialPos?: { x: number; y: number }
): void {
  liveVelocity = { vx: 0, vy: 0, lastTime: -1 };
  liveSmoothPos = initialPos ? { ...initialPos } : null;
  livePrevFrameData = null;
  liveRunningTemplate = initialTemplate;
}

export function interpolateTrackedPathAtTime(
  trackedPath: TrackedObjectPoint[] | undefined,
  time: number
): { x: number; y: number } | null {
  // Prefer user-anchor spline whenever 2+ user Focus Lock Points exist
  const spline = evaluateUserAnchorSplineAtTime(trackedPath, time);
  if (spline && spline.userAnchorCount >= 2 && spline.isBetweenUserAnchors) {
    return { x: spline.x, y: spline.y };
  }

  if (!trackedPath || trackedPath.length === 0) return null;
  if (time <= trackedPath[0].time) {
    return { x: trackedPath[0].x, y: trackedPath[0].y };
  }
  if (time >= trackedPath[trackedPath.length - 1].time) {
    const last = trackedPath[trackedPath.length - 1];
    return { x: last.x, y: last.y };
  }
  for (let i = 0; i < trackedPath.length - 1; i++) {
    const a = trackedPath[i];
    const b = trackedPath[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = Math.max(0.0001, b.time - a.time);
      const r = (time - a.time) / span;
      // Smoothstep interpolation between keyframes to prevent linear corner-snapping
      const s = r * r * (3 - 2 * r);
      return {
        x: a.x + (b.x - a.x) * s,
        y: a.y + (b.y - a.y) * s,
      };
    }
  }
  return null;
}

export function trackSubjectSignatureInVideoFrame(
  videoEl: HTMLVideoElement | null,
  prevX: number,
  prevY: number,
  targetColorRgb?: [number, number, number],
  templateSig?: ObjectTemplateSignature,
  trackedPath?: TrackedObjectPoint[]
): { x: number; y: number; boxW?: number; boxH?: number } {
  if (!videoEl || videoEl.readyState < 2) {
    return { x: prevX, y: prevY };
  }

  // 1. Check if the user has placed 2+ Focus Lock Points that span this timestamp:
  // If so, follow the silky-smooth Monotone Cubic Hermite Spline between their Focus Lock Points!
  const userSpline = evaluateUserAnchorSplineAtTime(trackedPath, videoEl.currentTime);
  if (userSpline && userSpline.userAnchorCount >= 2 && userSpline.isBetweenUserAnchors) {
    liveSmoothPos = { x: userSpline.x, y: userSpline.y };
    return {
      x: userSpline.x,
      y: userSpline.y,
      boxW: templateSig?.boxW ?? 0.14,
      boxH: templateSig?.boxH ?? 0.14,
    };
  }

  const w = 240;
  const h = 135;
  const ctx = getLiveTrackContext(w, h);
  if (!ctx) return { x: prevX, y: prevY };

  try {
    ctx.drawImage(videoEl, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    // Reset velocity if video jumped/looped
    const jumped = Math.abs(videoEl.currentTime - liveVelocity.lastTime) > 0.6;
    if (jumped) {
      liveVelocity = { vx: 0, vy: 0, lastTime: videoEl.currentTime };
      livePrevFrameData = null;
      liveSmoothPos = { x: prevX, y: prevY };
    }

    const activeTemplate = liveRunningTemplate || templateSig;

    const res = trackObjectInFrameBuffer(
      data,
      liveTrackCanvas,
      w,
      h,
      prevX,
      prevY,
      liveVelocity.vx,
      liveVelocity.vy,
      activeTemplate,
      targetColorRgb,
      livePrevFrameData
    );

    liveVelocity = { vx: res.vx, vy: res.vy, lastTime: videoEl.currentTime };
    livePrevFrameData = new Uint8ClampedArray(data);
    if (res.adaptedTemplate) {
      liveRunningTemplate = res.adaptedTemplate;
    }

    // Extra Steadicam EMA low-pass filter on the live 60fps output so the box glides with zero jitter
    if (!liveSmoothPos) {
      liveSmoothPos = { x: res.x, y: res.y };
    } else {
      const dx = res.x - liveSmoothPos.x;
      const dy = res.y - liveSmoothPos.y;
      const dist = Math.hypot(dx, dy);
      const alpha = dist < 0.008 ? 0.05 : dist < 0.025 ? 0.16 : 0.28;
      const stepX = Math.max(-0.015, Math.min(0.015, dx * alpha));
      const stepY = Math.max(-0.012, Math.min(0.012, dy * alpha));
      liveSmoothPos = {
        x: Number((liveSmoothPos.x + stepX).toFixed(4)),
        y: Number((liveSmoothPos.y + stepY).toFixed(4)),
      };
    }

    return {
      x: liveSmoothPos.x,
      y: liveSmoothPos.y,
      boxW: res.boxW,
      boxH: res.boxH,
    };
  } catch {
    return { x: prevX, y: prevY };
  }
}

/**
 * Automatically solves the clicked object's full trajectory forward and backward across `[startTime, endTime]`
 * using an offscreen `<video>` decoder + MediaPipe Neural ObjectDetector + 2D Template ZNCC + Kalman Filter!
 * This ensures that scrubbing to the end of the video or exporting the clip keeps the object centered the whole time.
 */
let activeTrajectoryAbortId = 0;

export async function solveClickedObjectTrajectory(
  videoUrl: string,
  startTime: number,
  endTime: number,
  anchorTime: number,
  anchorX: number,
  anchorY: number,
  templateSig?: ObjectTemplateSignature,
  targetColorRgb?: [number, number, number],
  existingUserAnchors: TrackedObjectPoint[] = [],
  onProgress?: (pct: number, partialPath: TrackedObjectPoint[]) => void
): Promise<TrackedObjectPoint[]> {
  const runId = ++activeTrajectoryAbortId;
  await ensureNeuralObjectDetector();

  const vid = document.createElement('video');
  vid.src = videoUrl;
  vid.muted = true;
  vid.playsInline = true;
  vid.preload = 'auto';

  await new Promise<void>((resolve, reject) => {
    vid.onloadeddata = () => resolve();
    vid.onerror = () => reject(new Error('Could not load video for object tracking pass'));
  });

  const w = 240;
  const h = 135;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];

  const seekAndRead = async (t: number): Promise<Uint8ClampedArray> => {
    vid.currentTime = Math.max(0, Math.min(vid.duration - 0.02, t));
    await new Promise<void>((res) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        vid.removeEventListener('seeked', finish);
        res();
      };
      vid.addEventListener('seeked', finish);
      setTimeout(finish, 180);
    });
    ctx.drawImage(vid, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  };

  const stepSec = Math.max(0.2, Math.min(0.4, (endTime - startTime) / 90));
  const anchorPoint: TrackedObjectPoint = {
    time: Number(anchorTime.toFixed(2)),
    x: anchorX,
    y: anchorY,
    boxW: templateSig?.boxW ?? 0.14,
    boxH: templateSig?.boxH ?? 0.16,
    confidence: 1.0,
    isUserAnchor: true,
  };

  const allUserAnchors = [
    ...existingUserAnchors.filter((a) => Math.abs(a.time - anchorTime) > 0.12),
    anchorPoint,
  ].sort((a, b) => a.time - b.time);

  const forwardPoints: TrackedObjectPoint[] = [];
  const backwardPoints: TrackedObjectPoint[] = [];

  const computeGlobalFrameDiff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
    let diff = 0;
    let count = 0;
    for (let i = 0; i < a.length; i += 16) {
      diff +=
        (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) /
        (3 * 255);
      count++;
    }
    return count > 0 ? diff / count : 0;
  };

  const anchorFrameData = new Uint8ClampedArray(await seekAndRead(anchorTime));
  if (runId !== activeTrajectoryAbortId) return [];

  // 1. Forward pass from anchorTime -> endTime
  let curX = anchorX;
  let curY = anchorY;
  let vx = 0;
  let vy = 0;
  let prevFrameData: Uint8ClampedArray = anchorFrameData;
  let runningTemplate: ObjectTemplateSignature | undefined = templateSig;

  const totalSteps = Math.max(1, Math.ceil((endTime - startTime) / stepSec));
  let completedSteps = 0;

  for (let t = anchorTime + stepSec; t <= endTime + 0.05; t += stepSec) {
    if (runId !== activeTrajectoryAbortId) return [];
    const clampedT = Number(Math.min(endTime, t).toFixed(2));

    // Check if user placed another manual anchor near this timestamp
    const manualNear = allUserAnchors.find((a) => Math.abs(a.time - clampedT) < stepSec * 0.6);
    const splineAtT = evaluateUserAnchorSplineAtTime(allUserAnchors, clampedT);

    if (manualNear) {
      curX = manualNear.x;
      curY = manualNear.y;
      vx = 0;
      vy = 0;
      forwardPoints.push(manualNear);
    } else if (splineAtT && splineAtT.userAnchorCount >= 2 && splineAtT.isBetweenUserAnchors) {
      // Between two User Focus Lock Points: follow the smooth Monotone Cubic Hermite / S-curve spline directly!
      curX = splineAtT.x;
      curY = splineAtT.y;
      vx = 0;
      vy = 0;
      forwardPoints.push({
        time: clampedT,
        x: curX,
        y: curY,
        boxW: templateSig?.boxW ?? 0.14,
        boxH: templateSig?.boxH ?? 0.14,
        confidence: 0.99,
      });
    } else {
      const data = await seekAndRead(clampedT);
      if (runId !== activeTrajectoryAbortId) return [];
      const sceneCutDelta = computeGlobalFrameDiff(data, prevFrameData);

      // If a hard camera cut occurred, zero velocity so momentum from the old shot doesn't fling the tracker
      if (sceneCutDelta > 0.22) {
        vx = 0;
        vy = 0;
      }

      const tracked = trackObjectInFrameBuffer(
        data,
        canvas,
        w,
        h,
        curX,
        curY,
        vx,
        vy,
        runningTemplate,
        targetColorRgb,
        sceneCutDelta > 0.22 ? null : prevFrameData
      );
      curX = tracked.x;
      curY = tracked.y;
      vx = tracked.vx;
      vy = tracked.vy;
      if (tracked.adaptedTemplate) {
        runningTemplate = tracked.adaptedTemplate;
      }
      prevFrameData = new Uint8ClampedArray(data);
      forwardPoints.push({
        time: clampedT,
        x: curX,
        y: curY,
        boxW: tracked.boxW,
        boxH: tracked.boxH,
        confidence: tracked.confidence,
      });
    }

    completedSteps++;
    if (completedSteps % 4 === 0 && onProgress && runId === activeTrajectoryAbortId) {
      const merged = [...backwardPoints, ...allUserAnchors, ...forwardPoints].sort(
        (a, b) => a.time - b.time
      );
      onProgress(Math.min(98, Math.round((completedSteps / totalSteps) * 100)), merged);
    }
  }

  // 2. Backward pass from anchorTime -> startTime
  curX = anchorX;
  curY = anchorY;
  vx = 0;
  vy = 0;
  prevFrameData = anchorFrameData;
  runningTemplate = templateSig;

  for (let t = anchorTime - stepSec; t >= startTime - 0.05; t -= stepSec) {
    if (runId !== activeTrajectoryAbortId) return [];
    const clampedT = Number(Math.max(startTime, t).toFixed(2));

    const manualNear = allUserAnchors.find((a) => Math.abs(a.time - clampedT) < stepSec * 0.6);
    const splineAtT = evaluateUserAnchorSplineAtTime(allUserAnchors, clampedT);

    if (manualNear) {
      curX = manualNear.x;
      curY = manualNear.y;
      vx = 0;
      vy = 0;
      backwardPoints.push(manualNear);
    } else if (splineAtT && splineAtT.userAnchorCount >= 2 && splineAtT.isBetweenUserAnchors) {
      curX = splineAtT.x;
      curY = splineAtT.y;
      vx = 0;
      vy = 0;
      backwardPoints.push({
        time: clampedT,
        x: curX,
        y: curY,
        boxW: templateSig?.boxW ?? 0.14,
        boxH: templateSig?.boxH ?? 0.14,
        confidence: 0.99,
      });
    } else {
      const data = await seekAndRead(clampedT);
      if (runId !== activeTrajectoryAbortId) return [];
      const sceneCutDelta = computeGlobalFrameDiff(data, prevFrameData);
      if (sceneCutDelta > 0.22) {
        vx = 0;
        vy = 0;
      }

      const tracked = trackObjectInFrameBuffer(
        data,
        canvas,
        w,
        h,
        curX,
        curY,
        vx,
        vy,
        runningTemplate,
        targetColorRgb,
        sceneCutDelta > 0.22 ? null : prevFrameData
      );
      curX = tracked.x;
      curY = tracked.y;
      vx = tracked.vx;
      vy = tracked.vy;
      if (tracked.adaptedTemplate) {
        runningTemplate = tracked.adaptedTemplate;
      }
      prevFrameData = new Uint8ClampedArray(data);
      backwardPoints.push({
        time: clampedT,
        x: curX,
        y: curY,
        boxW: tracked.boxW,
        boxH: tracked.boxH,
        confidence: tracked.confidence,
      });
    }

    completedSteps++;
    if (completedSteps % 4 === 0 && onProgress && runId === activeTrajectoryAbortId) {
      const merged = [...backwardPoints, ...allUserAnchors, ...forwardPoints].sort(
        (a, b) => a.time - b.time
      );
      onProgress(Math.min(98, Math.round((completedSteps / totalSteps) * 100)), merged);
    }
  }

  if (runId !== activeTrajectoryAbortId) return [];

  // Deduplicate non-anchor points by timestamp while ALWAYS keeping every user anchor intact
  const nonAnchors = [...backwardPoints, ...forwardPoints]
    .filter((pt) => !pt.isUserAnchor && !allUserAnchors.some((a) => Math.abs(a.time - pt.time) < 0.08))
    .sort((a, b) => a.time - b.time);

  const dedupedNonAnchors: TrackedObjectPoint[] = [];
  for (const pt of nonAnchors) {
    const prev = dedupedNonAnchors[dedupedNonAnchors.length - 1];
    if (!prev || Math.abs(prev.time - pt.time) >= 0.08) {
      dedupedNonAnchors.push(pt);
    }
  }

  const fullPath: TrackedObjectPoint[] = [...allUserAnchors, ...dedupedNonAnchors].sort(
    (a, b) => a.time - b.time
  );

  // Multi-pass Gaussian temporal smoothing over non-anchor points to eliminate all frame-to-frame jitter
  let smoothedPath: TrackedObjectPoint[] = fullPath;
  for (let pass = 0; pass < 4; pass++) {
    smoothedPath = smoothedPath.map((pt, i, arr) => {
      if (pt.isUserAnchor || i === 0 || i === arr.length - 1) return pt;
      const pPrev = arr[i - 1];
      const pNext = arr[i + 1];
      return {
        ...pt,
        x: Number((pPrev.x * 0.28 + pt.x * 0.44 + pNext.x * 0.28).toFixed(4)),
        y: Number((pPrev.y * 0.28 + pt.y * 0.44 + pNext.y * 0.28).toFixed(4)),
      };
    });
  }

  if (runId !== activeTrajectoryAbortId) return [];
  onProgress?.(100, smoothedPath);
  return smoothedPath;
}

/**
 * Applies a deadzone + critically damped spring camera solver over raw subject coordinates.
 */
export function solveSmoothedCameraPath(
  samples: TrackingSample[],
  options: {
    smoothing: number;
    deadzone: number;
    offsetX?: number;
    sceneCuts?: number[];
    manualKeyframes?: Array<{ time: number; cropX: number; cropY: number }>;
  }
): TrackingSample[] {
  if (samples.length === 0) return [];

  const minCenterX = 0.08;
  const maxCenterX = 0.92;
  const clampX = (v: number) => Math.max(minCenterX, Math.min(maxCenterX, v));
  const clampY = (v: number) => Math.max(0.15, Math.min(0.85, v));

  const offsetX = options.offsetX ?? 0;
  const alpha = 1 - Math.max(0.08, Math.min(0.96, options.smoothing));
  const deadzone = Math.max(0.01, Math.min(0.25, options.deadzone));
  const sceneCuts = options.sceneCuts || [];
  const keyframes = options.manualKeyframes || [];

  let currentX = clampX(samples[0].rawX + offsetX);
  let currentY = clampY(samples[0].rawY);
  let velocityX = 0;

  return samples.map((s, idx) => {
    const prevTime = idx > 0 ? samples[idx - 1].time : s.time;
    const crossedSceneCut = sceneCuts.some((cutT) => cutT > prevTime && cutT <= s.time);

    const manualKf = keyframes.find((kf) => Math.abs(kf.time - s.time) < 0.35);
    if (manualKf) {
      currentX = clampX(manualKf.cropX + offsetX);
      currentY = clampY(manualKf.cropY);
      velocityX = 0;
      return {
        ...s,
        cropX: currentX,
        cropY: currentY,
        isManualKeyframe: true,
      };
    }

    const targetX = clampX(s.rawX + offsetX);
    const targetY = clampY(s.rawY);

    if (crossedSceneCut || idx === 0) {
      currentX = targetX;
      currentY = targetY;
      velocityX = 0;
    } else {
      const errorX = targetX - currentX;
      if (Math.abs(errorX) > deadzone) {
        const effectiveError = errorX - Math.sign(errorX) * deadzone * 0.5;
        velocityX = velocityX * (1 - alpha * 0.7) + effectiveError * alpha * 0.85;
        currentX = clampX(currentX + velocityX);
      } else {
        velocityX *= 0.6;
        currentX = clampX(currentX + velocityX * 0.25);
      }
      currentY = clampY(currentY + (targetY - currentY) * alpha * 0.5);
    }

    return {
      ...s,
      cropX: Number(currentX.toFixed(4)),
      cropY: Number(currentY.toFixed(4)),
    };
  });
}

/**
 * Resolves the exact 9:16 subject focus coordinate at any timestamp `t`.
 * When `strategy === 'click-track'`, it interpolates directly along `subjectFocus.trackedPath`
 * (or uses the live tracked object position) WITHOUT any static anchor tethering, so the 9:16 crop
 * follows the clicked object all the way across the frame!
 */
export function getTrackingStateAtTime(
  samples: TrackingSample[],
  time: number,
  extraOffsetX = 0,
  manualKeyframes: Array<{ time: number; cropX: number; cropY: number }> = [],
  subjectFocus?: SubjectFocusConfig
): TrackingSample {
  const minCenterX = 0.06;
  const maxCenterX = 0.94;
  const clampX = (v: number) => Math.max(minCenterX, Math.min(maxCenterX, v));
  const clampY = (v: number) => Math.max(0.12, Math.min(0.88, v));

  let baseSample: TrackingSample = {
    time,
    rawX: 0.5,
    rawY: 0.5,
    cropX: 0.5,
    cropY: 0.5,
    leftSubjectX: 0.3,
    rightSubjectX: 0.7,
    faceX: 0.5,
    faceY: 0.45,
    motionX: 0.5,
    motionY: 0.5,
    confidence: 0.92,
    subjectLabel: 'Subject Lock',
  };

  if (samples && samples.length > 0) {
    if (time <= samples[0].time) {
      baseSample = { ...samples[0], time };
    } else if (time >= samples[samples.length - 1].time) {
      baseSample = { ...samples[samples.length - 1], time };
    } else {
      for (let i = 0; i < samples.length - 1; i++) {
        const a = samples[i];
        const b = samples[i + 1];
        if (time >= a.time && time <= b.time) {
          const span = Math.max(0.0001, b.time - a.time);
          const t = (time - a.time) / span;
          const lerp = (v1 = 0.5, v2 = 0.5) => v1 + (v2 - v1) * t;
          baseSample = {
            time,
            rawX: lerp(a.rawX, b.rawX),
            rawY: lerp(a.rawY, b.rawY),
            cropX: lerp(a.cropX, b.cropX),
            cropY: lerp(a.cropY, b.cropY),
            leftSubjectX: lerp(a.leftSubjectX ?? 0.3, b.leftSubjectX ?? 0.3),
            rightSubjectX: lerp(a.rightSubjectX ?? 0.7, b.rightSubjectX ?? 0.7),
            faceX: lerp(a.faceX ?? a.cropX, b.faceX ?? b.cropX),
            faceY: lerp(a.faceY ?? a.cropY, b.faceY ?? b.cropY),
            motionX: lerp(a.motionX ?? a.cropX, b.motionX ?? b.cropX),
            motionY: lerp(a.motionY ?? a.cropY, b.motionY ?? b.cropY),
            confidence: lerp(a.confidence, b.confidence),
            subjectLabel: a.subjectLabel,
          };
          break;
        }
      }
    }
  }

  if (subjectFocus) {
    const { strategy, anchorX, anchorY, label, trackedPath, templateSignature } = subjectFocus;

    if (strategy === 'static-lock') {
      return {
        ...baseSample,
        rawX: anchorX,
        rawY: anchorY,
        cropX: clampX(anchorX + extraOffsetX),
        cropY: clampY(anchorY),
        confidence: 1.0,
        subjectLabel: label || 'Pinned Position Lock',
        isManualKeyframe: true,
      };
    }

    if (strategy === 'click-track') {
      // 1. If the user placed 2+ Focus Lock Points, evaluate the smooth Monotone Cubic Hermite / S-curve spline first!
      const userSpline = evaluateUserAnchorSplineAtTime(trackedPath, time);
      if (userSpline && userSpline.userAnchorCount >= 2 && userSpline.isBetweenUserAnchors) {
        return {
          ...baseSample,
          rawX: userSpline.x,
          rawY: userSpline.y,
          cropX: clampX(userSpline.x + extraOffsetX),
          cropY: clampY(userSpline.y),
          objectBoxW: templateSignature?.boxW ?? 0.14,
          objectBoxH: templateSignature?.boxH ?? 0.14,
          confidence: 0.99,
          subjectLabel: `${label || 'Focus Blend'} (${userSpline.userAnchorCount} Lock Points)`,
          isManualKeyframe: true,
        };
      }

      // 2. If we have a solved multi-frame trajectory (`trackedPath`), interpolate with smoothstep!
      if (trackedPath && trackedPath.length > 0) {
        if (time <= trackedPath[0].time) {
          const p = trackedPath[0];
          return {
            ...baseSample,
            rawX: p.x,
            rawY: p.y,
            cropX: clampX(p.x + extraOffsetX),
            cropY: clampY(p.y),
            objectBoxW: p.boxW ?? templateSignature?.boxW ?? 0.14,
            objectBoxH: p.boxH ?? templateSignature?.boxH ?? 0.16,
            confidence: p.confidence ?? 0.98,
            subjectLabel: label || 'Tracked Object Lock',
            isManualKeyframe: true,
          };
        }
        if (time >= trackedPath[trackedPath.length - 1].time) {
          const p = trackedPath[trackedPath.length - 1];
          return {
            ...baseSample,
            rawX: p.x,
            rawY: p.y,
            cropX: clampX(p.x + extraOffsetX),
            cropY: clampY(p.y),
            objectBoxW: p.boxW ?? templateSignature?.boxW ?? 0.14,
            objectBoxH: p.boxH ?? templateSignature?.boxH ?? 0.16,
            confidence: p.confidence ?? 0.98,
            subjectLabel: label || 'Tracked Object Lock',
            isManualKeyframe: true,
          };
        }

        for (let i = 0; i < trackedPath.length - 1; i++) {
          const a = trackedPath[i];
          const b = trackedPath[i + 1];
          if (time >= a.time && time <= b.time) {
            const span = Math.max(0.0001, b.time - a.time);
            const r = (time - a.time) / span;
            const s = r * r * (3 - 2 * r);
            const ix = a.x + (b.x - a.x) * s;
            const iy = a.y + (b.y - a.y) * s;
            const bw = (a.boxW ?? 0.14) + ((b.boxW ?? 0.14) - (a.boxW ?? 0.14)) * s;
            const bh = (a.boxH ?? 0.16) + ((b.boxH ?? 0.16) - (a.boxH ?? 0.16)) * s;
            return {
              ...baseSample,
              rawX: ix,
              rawY: iy,
              cropX: clampX(ix + extraOffsetX),
              cropY: clampY(iy),
              objectBoxW: bw,
              objectBoxH: bh,
              confidence: a.confidence ?? 0.98,
              subjectLabel: label || 'Tracked Object Lock',
              isManualKeyframe: true,
            };
          }
        }
      }

      // Live real-time tracked anchor (100% following the object, zero static center tether!)
      return {
        ...baseSample,
        rawX: anchorX,
        rawY: anchorY,
        cropX: clampX(anchorX + extraOffsetX),
        cropY: clampY(anchorY),
        objectBoxW: templateSignature?.boxW ?? 0.14,
        objectBoxH: templateSignature?.boxH ?? 0.16,
        confidence: 0.99,
        subjectLabel: label || 'Tracked Object Focus',
        isManualKeyframe: true,
      };
    }

    if (strategy === 'left-subject') {
      const lx = baseSample.leftSubjectX ?? 0.3;
      return {
        ...baseSample,
        rawX: lx,
        cropX: clampX(lx + extraOffsetX),
        cropY: clampY(baseSample.cropY),
        confidence: 0.96,
        subjectLabel: 'Left Subject Focus',
      };
    }

    if (strategy === 'right-subject') {
      const rx = baseSample.rightSubjectX ?? 0.7;
      return {
        ...baseSample,
        rawX: rx,
        cropX: clampX(rx + extraOffsetX),
        cropY: clampY(baseSample.cropY),
        confidence: 0.96,
        subjectLabel: 'Right Subject Focus',
      };
    }

    if (strategy === 'face-speaker') {
      const fx = baseSample.faceX ?? baseSample.cropX;
      const fy = baseSample.faceY ?? baseSample.cropY;
      return {
        ...baseSample,
        rawX: fx,
        rawY: fy,
        cropX: clampX(fx + extraOffsetX),
        cropY: clampY(fy),
        confidence: 0.96,
        subjectLabel: 'Auto Face / Speaker',
      };
    }

    if (strategy === 'action-motion') {
      const mx = baseSample.motionX ?? baseSample.cropX;
      const my = baseSample.motionY ?? baseSample.cropY;
      return {
        ...baseSample,
        rawX: mx,
        rawY: my,
        cropX: clampX(mx + extraOffsetX),
        cropY: clampY(my),
        confidence: 0.95,
        subjectLabel: 'Action / Motion Focus',
      };
    }
  }

  if (manualKeyframes && manualKeyframes.length > 0) {
    const sorted = [...manualKeyframes].sort((a, b) => a.time - b.time);
    if (sorted.length === 1) {
      const kf = sorted[0];
      return {
        ...baseSample,
        rawX: kf.cropX,
        rawY: kf.cropY,
        cropX: clampX(kf.cropX + extraOffsetX),
        cropY: clampY(kf.cropY),
        confidence: 1.0,
        subjectLabel: 'Locked Subject Focus',
        isManualKeyframe: true,
      };
    }

    if (time <= sorted[0].time) {
      const kf = sorted[0];
      return {
        ...baseSample,
        rawX: kf.cropX,
        rawY: kf.cropY,
        cropX: clampX(kf.cropX + extraOffsetX),
        cropY: clampY(kf.cropY),
        confidence: 1.0,
        subjectLabel: 'Keyframe Path Focus',
        isManualKeyframe: true,
      };
    }

    if (time >= sorted[sorted.length - 1].time) {
      const kf = sorted[sorted.length - 1];
      return {
        ...baseSample,
        rawX: kf.cropX,
        rawY: kf.cropY,
        cropX: clampX(kf.cropX + extraOffsetX),
        cropY: clampY(kf.cropY),
        confidence: 1.0,
        subjectLabel: 'Keyframe Path Focus',
        isManualKeyframe: true,
      };
    }

    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (time >= a.time && time <= b.time) {
        const span = Math.max(0.0001, b.time - a.time);
        const ratio = (time - a.time) / span;
        const ix = a.cropX + (b.cropX - a.cropX) * ratio;
        const iy = a.cropY + (b.cropY - a.cropY) * ratio;
        return {
          ...baseSample,
          rawX: ix,
          rawY: iy,
          cropX: clampX(ix + extraOffsetX),
          cropY: clampY(iy),
          confidence: 1.0,
          subjectLabel: 'Keyframe Path Focus',
          isManualKeyframe: true,
        };
      }
    }
  }

  return {
    ...baseSample,
    cropX: clampX(baseSample.cropX + extraOffsetX),
    cropY: clampY(baseSample.cropY),
  };
}

export function computeDistortionFree9x16Crop(
  videoWidth: number,
  videoHeight: number,
  centerX: number,
  centerY: number,
  zoom = 1.0
): {
  normX: number;
  normY: number;
  normW: number;
  normH: number;
  sx: number;
  sy: number;
  sw: number;
  sh: number;
} {
  const vw = Math.max(1, videoWidth || 1920);
  const vh = Math.max(1, videoHeight || 1080);
  const safeZoom = Math.max(1.0, Math.min(2.5, zoom || 1.0));
  const targetAspect = 9 / 16;
  const sourceAspect = vw / vh;

  let sw: number;
  let sh: number;

  if (sourceAspect >= targetAspect) {
    sh = vh / safeZoom;
    sw = sh * targetAspect;
  } else {
    sw = vw / safeZoom;
    sh = sw / targetAspect;
  }

  const normW = Math.min(1, sw / vw);
  const normH = Math.min(1, sh / vh);

  const normX = Math.max(0, Math.min(1 - normW, centerX - normW / 2));
  const normY = Math.max(0, Math.min(1 - normH, centerY - normH / 2));

  return {
    normX,
    normY,
    normW,
    normH,
    sx: normX * vw,
    sy: normY * vh,
    sw: normW * vw,
    sh: normH * vh,
  };
}
