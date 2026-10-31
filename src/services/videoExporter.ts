import { GeneratedClip, SourceVideoAsset, SubCut } from '../types/editor';
import {
  computeDistortionFree9x16Crop,
  getTrackingStateAtTime,
  trackSubjectSignatureInVideoFrame,
} from './subjectTracker';

/**
 * Renders the full `GeneratedClip` into a real 9:16 vertical video file (`.webm`)
 * WITH synchronized audio (captured from the source video element) + distortion-free 9:16
 * subject-tracked cropping, dynamic punch-in zooms, and captions, then downloads the file.
 * Supports both continuous segment clips AND multi-cut condensed video edits (`subCuts`),
 * and honors `clip.subjectFocus` (including live color-patch tracking for clicked subjects).
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

  const cutsToRender: SubCut[] =
    clip.subCuts && clip.subCuts.length > 0
      ? clip.subCuts
      : [
          {
            id: 'default-cut',
            index: 1,
            sourceStart: clip.sourceStart,
            sourceEnd: clip.sourceEnd,
            timelineStart: 0,
            timelineEnd: clip.duration,
            label: 'Clip',
            zoom: clip.zoomScale,
            cropBiasX: 0,
          },
        ];

  let liveTrackedX = clip.subjectFocus?.anchorX ?? 0.5;
  let liveTrackedY = clip.subjectFocus?.anchorY ?? 0.5;

  const draw9x16Frame = (sourceTime: number, clipRelTime: number, activeCut: SubCut) => {
    const cutZoom = activeCut ? activeCut.zoom : clip.zoomScale;
    const cutBias = activeCut ? activeCut.cropBiasX : 0;

    let activeFocus = clip.subjectFocus;
    if (activeFocus?.strategy === 'click-track' && activeFocus.targetColorRgb) {
      const tracked = trackSubjectSignatureInVideoFrame(
        videoEl,
        liveTrackedX,
        liveTrackedY,
        activeFocus.targetColorRgb
      );
      liveTrackedX = tracked.x;
      liveTrackedY = tracked.y;
      activeFocus = {
        ...activeFocus,
        anchorX: liveTrackedX,
        anchorY: liveTrackedY,
      };
    }

    const track = getTrackingStateAtTime(
      source.trackingSamples,
      sourceTime,
      clip.trackingOffsetX + cutBias,
      clip.manualKeyframes,
      activeFocus
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

  const seekVideoTo = async (targetTime: number) => {
    if (Math.abs(videoEl.currentTime - targetTime) < 0.06) return;
    videoEl.currentTime = targetTime;
    await new Promise<void>((res) => {
      const onSeek = () => {
        videoEl.removeEventListener('seeked', onSeek);
        res();
      };
      videoEl.addEventListener('seeked', onSeek);
      setTimeout(onSeek, 250);
    });
  };

  await seekVideoTo(cutsToRender[0].sourceStart);
  recorder.start(100);

  for (let i = 0; i < cutsToRender.length; i++) {
    const cut = cutsToRender[i];
    if (Math.abs(videoEl.currentTime - cut.sourceStart) > 0.1) {
      if (recorder.state === 'recording') {
        try {
          recorder.pause();
        } catch {}
      }
      videoEl.pause();
      await seekVideoTo(cut.sourceStart);
      if (recorder.state === 'paused') {
        try {
          recorder.resume();
        } catch {}
      }
    }

    await videoEl.play();

    await new Promise<void>((resolve) => {
      const loop = () => {
        const t = videoEl.currentTime;
        const clipRelTime = cut.timelineStart + Math.max(0, t - cut.sourceStart);
        const pct = Math.min(
          99,
          Math.max(1, Math.round((clipRelTime / Math.max(0.5, clip.duration)) * 100))
        );
        onProgress?.(pct);
        draw9x16Frame(t, clipRelTime, cut);

        if (t >= cut.sourceEnd || videoEl.ended) {
          resolve();
          return;
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
  }

  videoEl.pause();
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
