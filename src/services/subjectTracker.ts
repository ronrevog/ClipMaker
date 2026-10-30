import { TrackingSample, TrackingMode } from '../types/editor';

/**
 * Analyzes an HTML5 Canvas image buffer (downsampled e.g. 160x90) to find the dominant
 * subject centroid (0..1, 0..1) using a fusion of:
 * 1. Frame-to-frame temporal motion difference (moving objects/people/cars)
 * 2. Portrait/skin-tone & warm-color chroma salience (faces/speakers)
 * 3. High-frequency edge/luminance contrast with center-horizon prior
 */
export function detectFrameSubjectCentroid(
  currData: Uint8ClampedArray,
  prevData: Uint8ClampedArray | null,
  width: number,
  height: number,
  mode: TrackingMode = 'primary-subject'
): { x: number; y: number; confidence: number; motionScore: number; sceneDelta: number; label: string } {
  let weightedX = 0;
  let weightedY = 0;
  let totalWeight = 0;
  let totalMotion = 0;
  let totalSceneDelta = 0;
  let skinWeightSum = 0;
  let motionWeightSum = 0;

  const pixelCount = width * height;

  for (let y = 0; y < height; y++) {
    const ny = y / height;
    // Vertical prior: subjects are usually between 15% and 85% height
    const verticalPrior = Math.exp(-Math.pow((ny - 0.48) / 0.34, 2));

    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const idx = (y * width + x) * 4;
      const r = currData[idx];
      const g = currData[idx + 1];
      const b = currData[idx + 2];

      // Temporal motion delta
      let motion = 0;
      if (prevData) {
        const dr = Math.abs(r - prevData[idx]);
        const dg = Math.abs(g - prevData[idx + 1]);
        const db = Math.abs(b - prevData[idx + 2]);
        const diff = (dr + dg + db) / (3 * 255);
        totalSceneDelta += diff;
        if (diff > 0.06) {
          motion = Math.pow(diff, 1.3);
          totalMotion += diff;
        }
      }

      // Skin-tone / warm subject chroma heuristic
      const isWarmSkin =
        r > 85 &&
        g > 40 &&
        b > 25 &&
        r > g &&
        r > b &&
        Math.abs(r - g) > 12 &&
        r - b > 18;
      const skinScore = isWarmSkin ? 0.65 : 0;

      // Local spatial contrast (horizontal gradient approximation)
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

      let pixelWeight = 0.001;
      if (mode === 'center-lock') {
        pixelWeight = Math.exp(-Math.pow((nx - 0.5) / 0.15, 2));
      } else if (mode === 'face-speaker') {
        pixelWeight = (skinScore * 2.4 + motion * 1.4 + contrast * 0.7) * verticalPrior;
      } else if (mode === 'action-motion') {
        pixelWeight = (motion * 3.2 + contrast * 1.1 + skinScore * 0.6) * verticalPrior;
      } else {
        // primary-subject
        pixelWeight = (motion * 2.2 + skinScore * 1.5 + contrast * 0.9) * verticalPrior;
      }

      skinWeightSum += skinScore;
      motionWeightSum += motion;
      weightedX += nx * pixelWeight;
      weightedY += ny * pixelWeight;
      totalWeight += pixelWeight;
    }
  }

  const rawX = totalWeight > 0 ? Math.max(0.16, Math.min(0.84, weightedX / totalWeight)) : 0.5;
  const rawY = totalWeight > 0 ? Math.max(0.22, Math.min(0.78, weightedY / totalWeight)) : 0.48;
  const motionScore = Math.min(100, Math.round((totalMotion / Math.max(1, pixelCount)) * 950));
  const sceneDelta = totalSceneDelta / Math.max(1, pixelCount);
  const confidence = Math.max(0.58, Math.min(0.98, 0.62 + (motionWeightSum + skinWeightSum) / (pixelCount * 0.5)));

  const label =
    skinWeightSum > motionWeightSum * 1.3
      ? 'Speaker / Face'
      : motionScore > 25
        ? 'Moving Subject'
        : 'Salient Subject';

  return { x: rawX, y: rawY, confidence, motionScore, sceneDelta, label };
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

  // In a 16:9 frame, a 9:16 crop window has normalized width = (9/16) / (16/9) = 81/256 ≈ 0.3164
  // So the crop center X must stay within [0.158, 0.842] so the 9:16 window never leaves the 16:9 frame.
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

    // Check if there is a nearby manual keyframe override
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
      // Snap cleanly on hard camera cut
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
 * Fast O(log N) / linear interpolated lookup of the subject tracking state at any timestamp `t`.
 */
export function getTrackingStateAtTime(
  samples: TrackingSample[],
  time: number,
  extraOffsetX = 0,
  manualKeyframes: Array<{ time: number; cropX: number; cropY: number }> = []
): TrackingSample {
  const minCenterX = 0.16;
  const maxCenterX = 0.84;
  const clampX = (v: number) => Math.max(minCenterX, Math.min(maxCenterX, v));

  if (!samples || samples.length === 0) {
    return {
      time,
      rawX: 0.5,
      rawY: 0.5,
      cropX: clampX(0.5 + extraOffsetX),
      cropY: 0.5,
      confidence: 0.9,
      subjectLabel: 'Subject Lock',
    };
  }

  // Check manual keyframes first
  if (manualKeyframes.length > 0) {
    const exactKf = manualKeyframes.find((k) => Math.abs(k.time - time) < 0.25);
    if (exactKf) {
      return {
        time,
        rawX: exactKf.cropX,
        rawY: exactKf.cropY,
        cropX: clampX(exactKf.cropX + extraOffsetX),
        cropY: exactKf.cropY,
        confidence: 1.0,
        subjectLabel: 'Manual Keyframe',
        isManualKeyframe: true,
      };
    }
  }

  if (time <= samples[0].time) {
    const s = samples[0];
    return { ...s, cropX: clampX(s.cropX + extraOffsetX) };
  }
  if (time >= samples[samples.length - 1].time) {
    const s = samples[samples.length - 1];
    return { ...s, cropX: clampX(s.cropX + extraOffsetX) };
  }

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = Math.max(0.0001, b.time - a.time);
      const t = (time - a.time) / span;
      return {
        time,
        rawX: a.rawX + (b.rawX - a.rawX) * t,
        rawY: a.rawY + (b.rawY - a.rawY) * t,
        cropX: clampX(a.cropX + (b.cropX - a.cropX) * t + extraOffsetX),
        cropY: a.cropY + (b.cropY - a.cropY) * t,
        confidence: a.confidence + (b.confidence - a.confidence) * t,
        subjectLabel: a.subjectLabel,
      };
    }
  }

  const last = samples[samples.length - 1];
  return { ...last, cropX: clampX(last.cropX + extraOffsetX) };
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
    // Source is wider than 9:16 (e.g. 16:9, 4:3, 1:1) -> height is the base dimension
    sh = vh / safeZoom;
    sw = sh * targetAspect;
  } else {
    // Source is already narrower/taller than 9:16 -> width is the base dimension
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

