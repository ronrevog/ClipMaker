import { SubjectFocusConfig, TrackingMode, TrackingSample } from '../types/editor';

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

/**
 * Analyzes an HTML5 Canvas image buffer (downsampled e.g. 240x135) using a 12x6 spatial grid
 * to find TRUE localized subject clusters (0..1, 0..1) rather than averaging the whole image to 0.50:
 * - Primary Salient Subject Cluster (`x`, `y`)
 * - Left-Half Subject Cluster (`leftSubjectX`)
 * - Right-Half Subject Cluster (`rightSubjectX`)
 * - Face / Speaker Cluster (`faceX`, `faceY`)
 * - Action / Motion Cluster (`motionX`, `motionY`)
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
    // Vertical prior: subjects and faces are usually between 15% and 82% height
    const verticalPrior = Math.exp(-Math.pow((ny - 0.45) / 0.34, 2));

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

      // Skin-tone / warm foreground chroma heuristic
      const isWarmSkin =
        r > 82 &&
        g > 38 &&
        b > 22 &&
        r > g &&
        r > b &&
        Math.abs(r - g) > 11 &&
        r - b > 16;
      const skinScore = isWarmSkin ? 0.85 : 0;

      // Local spatial edge contrast + saturation salience
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
        (motion * 2.8 + skinScore * 1.9 + contrast * 1.35 + saturation * 0.45) * verticalPrior;
      const faceWeight =
        (skinScore * 2.8 + contrast * 1.1 + motion * 1.2) *
        Math.exp(-Math.pow((ny - 0.38) / 0.28, 2));
      const motWeight = (motion * 3.6 + contrast * 1.2) * verticalPrior;

      salGrid[cellIdx] += salWeight;
      skinGrid[cellIdx] += faceWeight;
      motionGrid[cellIdx] += motWeight;

      skinTotal += skinScore;
      motionTotal += motion;
    }
  }

  // Helper to find the 3x3 localized peak centroid inside a column range [minCol, maxCol]
  const findClusterPeak = (
    grid: Float32Array,
    minCol: number,
    maxCol: number,
    defaultX: number,
    defaultY: number
  ): { x: number; y: number; strength: number } => {
    let bestCol = Math.round(((minCol + maxCol) / 2));
    let bestRow = 2;
    let bestScore = -1;

    for (let r = 0; r < rows; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        // 3x3 neighborhood sum around (c, r) to find solid subject cluster
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

    // Refine sub-grid coordinate within 3x3 neighborhood around bestCol, bestRow
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
      x: Math.max(0.16, Math.min(0.84, cx)),
      y: Math.max(0.22, Math.min(0.78, cy)),
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
    leftSubjectX: Number(Math.max(0.16, Math.min(0.48, leftCluster.x)).toFixed(4)),
    rightSubjectX: Number(Math.max(0.52, Math.min(0.84, rightCluster.x)).toFixed(4)),
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

function getLiveTrackContext(w = 160, h = 90): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null;
  if (!liveTrackCanvas) {
    liveTrackCanvas = document.createElement('canvas');
    liveTrackCanvas.width = w;
    liveTrackCanvas.height = h;
    liveTrackCtx = liveTrackCanvas.getContext('2d', { willReadFrequently: true });
  }
  return liveTrackCtx;
}

/**
 * Samples the RGB color signature of a subject clicked by the user on the video at `(normX, normY)`.
 */
export function sampleSubjectSignatureFromVideo(
  videoEl: HTMLVideoElement | null,
  normX: number,
  normY: number
): [number, number, number] | undefined {
  if (!videoEl || videoEl.readyState < 2) return undefined;
  const w = 160;
  const h = 90;
  const ctx = getLiveTrackContext(w, h);
  if (!ctx) return undefined;

  try {
    ctx.drawImage(videoEl, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const cx = Math.max(3, Math.min(w - 4, Math.round(normX * w)));
    const cy = Math.max(3, Math.min(h - 4, Math.round(normY * h)));

    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let count = 0;

    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const idx = ((cy + dy) * w + (cx + dx)) * 4;
        rSum += data[idx];
        gSum += data[idx + 1];
        bSum += data[idx + 2];
        count++;
      }
    }

    if (count === 0) return undefined;
    return [Math.round(rSum / count), Math.round(gSum / count), Math.round(bSum / count)];
  } catch {
    return undefined;
  }
}

/**
 * Tracks a clicked subject across live video frames using color-patch similarity + local edge salience
 * within a search window around `(prevX, prevY)`, keeping the chosen subject locked in the center of 9:16.
 */
export function trackSubjectSignatureInVideoFrame(
  videoEl: HTMLVideoElement | null,
  prevX: number,
  prevY: number,
  targetColorRgb?: [number, number, number]
): { x: number; y: number } {
  if (!videoEl || videoEl.readyState < 2 || !targetColorRgb) {
    return { x: prevX, y: prevY };
  }

  const w = 160;
  const h = 90;
  const ctx = getLiveTrackContext(w, h);
  if (!ctx) return { x: prevX, y: prevY };

  try {
    ctx.drawImage(videoEl, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const [tr, tg, tb] = targetColorRgb;

    const searchRadiusX = Math.round(w * 0.22);
    const searchRadiusY = Math.round(h * 0.22);
    const centerPx = Math.round(prevX * w);
    const centerPy = Math.round(prevY * h);

    const minX = Math.max(4, centerPx - searchRadiusX);
    const maxX = Math.min(w - 5, centerPx + searchRadiusX);
    const minY = Math.max(4, centerPy - searchRadiusY);
    const maxY = Math.min(h - 5, centerPy + searchRadiusY);

    let weightedX = 0;
    let weightedY = 0;
    let totalW = 0;

    for (let y = minY; y <= maxY; y += 2) {
      for (let x = minX; x <= maxX; x += 2) {
        const idx = (y * w + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];

        const colorDist =
          (Math.abs(r - tr) + Math.abs(g - tg) + Math.abs(b - tb)) / (3 * 255);
        if (colorDist < 0.22) {
          const distPenalty = Math.hypot((x - centerPx) / w, (y - centerPy) / h);
          const wScore = Math.pow(1 - colorDist / 0.22, 2) * Math.exp(-distPenalty * 4.5);
          weightedX += (x / w) * wScore;
          weightedY += (y / h) * wScore;
          totalW += wScore;
        }
      }
    }

    if (totalW > 0.15) {
      const nextX = prevX * 0.65 + (weightedX / totalW) * 0.35;
      const nextY = prevY * 0.7 + (weightedY / totalW) * 0.3;
      return {
        x: Math.max(0.16, Math.min(0.84, nextX)),
        y: Math.max(0.24, Math.min(0.76, nextY)),
      };
    }
  } catch {
    // Ignore read errors
  }

  return { x: prevX, y: prevY };
}

/**
 * Applies a deadzone + critically damped spring camera solver over raw subject coordinates
 * so that the 9:16 crop window smoothly tracks the subject without micro-jitter, while
 * snapping cleanly across hard scene cuts.
 */
export function solveSmoothedCameraPath(
  samples: TrackingSample[],
  options: {
    smoothing: number; // 0.1 .. 0.96
    deadzone: number; // 0.02 .. 0.25
    offsetX?: number; // -0.35 .. +0.35
    sceneCuts?: number[];
    manualKeyframes?: Array<{ time: number; cropX: number; cropY: number }>;
  }
): TrackingSample[] {
  if (samples.length === 0) return [];

  const minCenterX = 0.16;
  const maxCenterX = 0.84;
  const clampX = (v: number) => Math.max(minCenterX, Math.min(maxCenterX, v));
  const clampY = (v: number) => Math.max(0.25, Math.min(0.75, v));

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
 * Resolves the exact 9:16 subject focus coordinate at any timestamp `t`, honoring:
 * 1. Persistent `SubjectFocusConfig` strategies (`'click-track'`, `'static-lock'`, `'left-subject'`, `'right-subject'`, `'face-speaker'`, `'action-motion'`, `'auto-salient'`)
 * 2. Piecewise-linear interpolation between manual keyframes (if multiple keyframes are set) or persistent lock if 1 keyframe is set
 * 3. Precomputed spatial cluster trajectories (`samples`)
 */
export function getTrackingStateAtTime(
  samples: TrackingSample[],
  time: number,
  extraOffsetX = 0,
  manualKeyframes: Array<{ time: number; cropX: number; cropY: number }> = [],
  subjectFocus?: SubjectFocusConfig
): TrackingSample {
  const minCenterX = 0.16;
  const maxCenterX = 0.84;
  const clampX = (v: number) => Math.max(minCenterX, Math.min(maxCenterX, v));
  const clampY = (v: number) => Math.max(0.24, Math.min(0.76, v));

  // Interpolate base sample at `time`
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

  // 1. Honor explicit SubjectFocusConfig strategy first!
  if (subjectFocus) {
    const { strategy, anchorX, anchorY, label } = subjectFocus;

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
      // Combine the user's clicked anchor with local subject trajectory relative to the side they clicked
      const isLeftSubject = anchorX < 0.44;
      const isRightSubject = anchorX > 0.56;
      const clusterTrackX = isLeftSubject
        ? baseSample.leftSubjectX ?? anchorX
        : isRightSubject
          ? baseSample.rightSubjectX ?? anchorX
          : baseSample.cropX;
      // Blend 70% user's tracked anchor + 30% local cluster motion so the picked subject stays centered in 9:16
      const trackedX = anchorX * 0.72 + clusterTrackX * 0.28;
      const trackedY = anchorY * 0.75 + baseSample.cropY * 0.25;
      return {
        ...baseSample,
        rawX: trackedX,
        rawY: trackedY,
        cropX: clampX(trackedX + extraOffsetX),
        cropY: clampY(trackedY),
        confidence: 0.99,
        subjectLabel: label || 'Tracked Subject Focus',
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

  // 2. If manual keyframes exist, interpolate persistently across the clip (never expire after 0.25s!)
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

/**
 * Computes an exact, distortion-free 9:16 crop rectangle inside a source video of ANY native
 * resolution (`videoWidth` x `videoHeight`).
 * Returns both normalized (0..1) coordinates for CSS overlays and exact source pixel coordinates
 * `(sx, sy, sw, sh)` for `<canvas>` drawing so the video is NEVER stretched.
 */
export function computeDistortionFree9x16Crop(
  videoWidth: number,
  videoHeight: number,
  centerX: number, // 0..1 desired horizontal center
  centerY: number, // 0..1 desired vertical center
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
  const targetAspect = 9 / 16; // 0.5625
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
