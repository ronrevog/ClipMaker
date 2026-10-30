import { GeneratedClip, SourceVideoAsset } from '../types/editor';
import { computeDistortionFree9x16Crop, getTrackingStateAtTime } from './subjectTracker';

/**
 * Renders the full `GeneratedClip` into a real 9:16 vertical video file (`.webm`)
 * WITH synchronized audio (captured from the source video element) + distortion-free 9:16
 * subject-tracked cropping, dynamic punch-in zooms, and captions, then downloads the file.
 */
export async function exportClipTo9x16Video(
  source: SourceVideoAsset,
  clip: GeneratedClip,
  onProgress?: (pct: number) => void
): Promise<void> {
  if (!source.url) {
    throw new Error('Please upload a video first before exporting.');
  }

  const outWidth = 720;
  const outHeight = 1280;
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize 9:16 export canvas');

  const canvasStream = canvas.captureStream(30);
  const combinedTracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

  const videoEl = document.createElement('video');
  videoEl.src = source.url;
  videoEl.muted = false;
  videoEl.volume = 1.0;
  videoEl.playsInline = true;
  await new Promise<void>((res, rej) => {
    videoEl.onloadeddata = () => res();
    videoEl.onerror = () => rej(new Error('Failed to load source video for export'));
  });

  try {
    const vidStream: MediaStream | undefined =
      typeof (videoEl as any).captureStream === 'function'
        ? (videoEl as any).captureStream()
        : typeof (videoEl as any).mozCaptureStream === 'function'
          ? (videoEl as any).mozCaptureStream()
          : undefined;
    if (vidStream) {
      const audioTracks = vidStream.getAudioTracks();
      if (audioTracks.length > 0) {
        combinedTracks.push(audioTracks[0]);
      }
    }
  } catch (e) {
    console.warn('Could not attach audio track from video element:', e);
  }

  const finalStream = new MediaStream(combinedTracks);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm';

  const recorder = new MediaRecorder(finalStream, {
    mimeType,
    videoBitsPerSecond: 6_000_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const vw = videoEl.videoWidth || source.width || 1920;
  const vh = videoEl.videoHeight || source.height || 1080;

  const draw9x16FrameAtTime = (sourceTime: number) => {
    const clipRelTime = Math.max(0, sourceTime - clip.sourceStart);
    const activeCut =
      clip.subCuts.find((c) => sourceTime >= c.sourceStart && sourceTime <= c.sourceEnd) ||
      clip.subCuts[0];
    const cutZoom = activeCut ? activeCut.zoom : clip.zoomScale;
    const cutBias = activeCut ? activeCut.cropBiasX : 0;

    const track = getTrackingStateAtTime(
      source.trackingSamples,
      sourceTime,
      clip.trackingOffsetX + cutBias,
      clip.manualKeyframes
    );

    const crop = computeDistortionFree9x16Crop(
      vw,
      vh,
      track.cropX,
      track.cropY,
      cutZoom
    );

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, outWidth, outHeight);

    ctx.drawImage(
      videoEl,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      outWidth,
      outHeight
    );

    const activeCaption = clip.captions.find(
      (c) => clipRelTime >= c.start && clipRelTime <= c.end
    );
    const displayText = activeCaption?.text || clip.captionText;
    if (displayText) {
      ctx.save();
      ctx.textAlign = 'center';
      ctx.font = '800 36px Inter, sans-serif';
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(40, outHeight * 0.78 - 44, outWidth - 80, 64);
      ctx.fillStyle = '#facc15';
      ctx.fillText(displayText, outWidth / 2, outHeight * 0.78);
      ctx.restore();
    }
  };

  videoEl.currentTime = clip.sourceStart;
  await new Promise<void>((res) => {
    const onSeek = () => {
      videoEl.removeEventListener('seeked', onSeek);
      res();
    };
    videoEl.addEventListener('seeked', onSeek);
    setTimeout(onSeek, 300);
  });

  recorder.start(100);
  await videoEl.play();

  await new Promise<void>((resolve) => {
    const loop = () => {
      const t = videoEl.currentTime;
      const pct = Math.min(
        99,
        Math.max(1, Math.round(((t - clip.sourceStart) / Math.max(0.5, clip.duration)) * 100))
      );
      onProgress?.(pct);
      draw9x16FrameAtTime(t);

      if (t >= clip.sourceEnd || videoEl.ended) {
        videoEl.pause();
        resolve();
        return;
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });

  recorder.stop();
  await new Promise<void>((res) => {
    recorder.onstop = () => res();
  });

  onProgress?.(100);
  const blob = new Blob(chunks, { type: mimeType });
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  const safeName = clip.name.replace(/[^a-z0-9_-]+/gi, '_');
  a.download = `${safeName}_9x16.webm`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
