import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { GeneratedClip, SourceVideoAsset, SubCut } from '../types/editor';
import { renderComposite9x16Frame } from './aiVideoEditorTools';
import {
  evaluateUserAnchorSplineAtTime,
  getTrackingStateAtTime,
  resetLiveObjectTrackerState,
  trackSubjectSignatureInVideoFrame,
} from './subjectTracker';

/**
 * Selects the best supported H.264 / AAC MP4 MIME type for MediaRecorder.
 */
function getSupportedMp4MimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const mp4Candidates = [
    'video/mp4;codecs=avc1.640028,mp4a.40.2',
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=h264,aac',
    'video/mp4;codecs=avc1',
    'video/mp4',
  ];
  for (const candidate of mp4Candidates) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Renders the full `GeneratedClip` into a classic 9:16 vertical `.mp4` video file (H.264/AAC)
 * WITH synchronized audio + distortion-free 9:16 subject-tracked cropping, multi-point Focus Lock
 * spline transitions, dynamic punch-in zooms, and captions, then downloads the `.mp4` file.
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
  const fps = 30;
  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize 9:16 export canvas');

  const videoEl = document.createElement('video');
  videoEl.src = source.url;
  videoEl.muted = false;
  videoEl.volume = 1.0;
  videoEl.playsInline = true;
  await new Promise<void>((res, rej) => {
    videoEl.onloadeddata = () => res();
    videoEl.onerror = () => rej(new Error('Failed to load source video for export'));
  });

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
  resetLiveObjectTrackerState(clip.subjectFocus?.templateSignature, {
    x: liveTrackedX,
    y: liveTrackedY,
  });

  const draw9x16Frame = (sourceTime: number, clipRelTime: number, activeCut: SubCut) => {
    const cutZoom = activeCut ? activeCut.zoom : clip.zoomScale;
    const cutBias = activeCut ? activeCut.cropBiasX : 0;

    let activeFocus = clip.subjectFocus;
    if (activeFocus?.strategy === 'click-track') {
      // 1. Check if multi-point user Focus Lock Spline is active at this timestamp
      const splinePt = evaluateUserAnchorSplineAtTime(activeFocus.trackedPath, sourceTime);
      if (splinePt && splinePt.userAnchorCount >= 2 && splinePt.isBetweenUserAnchors) {
        liveTrackedX = splinePt.x;
        liveTrackedY = splinePt.y;
        activeFocus = {
          ...activeFocus,
          anchorX: liveTrackedX,
          anchorY: liveTrackedY,
        };
      } else if (activeFocus.templateSignature || activeFocus.targetColorRgb) {
        // 2. Live frame-accurate tracking guided by solved trajectory & Steadicam anti-jitter filter
        const tracked = trackSubjectSignatureInVideoFrame(
          videoEl,
          liveTrackedX,
          liveTrackedY,
          activeFocus.targetColorRgb,
          activeFocus.templateSignature,
          activeFocus.trackedPath
        );
        liveTrackedX = tracked.x;
        liveTrackedY = tracked.y;
        activeFocus = {
          ...activeFocus,
          anchorX: liveTrackedX,
          anchorY: liveTrackedY,
          trackedPath: undefined,
        };
      }
    }

    const track = getTrackingStateAtTime(
      source.trackingSamples,
      sourceTime,
      clip.trackingOffsetX + cutBias,
      clip.manualKeyframes,
      activeFocus
    );

    renderComposite9x16Frame({
      ctx,
      videoEl,
      outW: outWidth,
      outH: outHeight,
      vw,
      vh,
      cropX: track.cropX,
      cropY: track.cropY,
      leftSubjectX: track.leftSubjectX,
      rightSubjectX: track.rightSubjectX,
      zoom: cutZoom,
      backgroundFillStyle: clip.backgroundFillStyle ?? 'blurred',
      activeClip: clip,
      clipPlayheadTime: clipRelTime,
    });
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

  const nativeMp4Mime = getSupportedMp4MimeType();

  // Optional WebCodecs H.264 MP4 Muxer fallback when MediaRecorder doesn't natively support video/mp4
  let mp4Muxer: Muxer<ArrayBufferTarget> | null = null;
  let webCodecsVideoEncoder: VideoEncoder | null = null;
  let encodedFrameIndex = 0;

  if (!nativeMp4Mime && typeof VideoEncoder !== 'undefined') {
    try {
      const target = new ArrayBufferTarget();
      mp4Muxer = new Muxer({
        target,
        video: {
          codec: 'avc',
          width: outWidth,
          height: outHeight,
        },
        fastStart: 'in-memory',
      });
      webCodecsVideoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          mp4Muxer?.addVideoChunk(chunk, meta);
        },
        error: (e) => console.warn('WebCodecs VideoEncoder error:', e),
      });
      webCodecsVideoEncoder.configure({
        codec: 'avc1.42001f',
        width: outWidth,
        height: outHeight,
        bitrate: 6_000_000,
        framerate: fps,
      });
    } catch (e) {
      console.warn('WebCodecs MP4 initialization fallback:', e);
      mp4Muxer = null;
      webCodecsVideoEncoder = null;
    }
  }

  let recorder: MediaRecorder | null = null;
  const chunks: BlobPart[] = [];
  const recorderMime =
    nativeMp4Mime ||
    (MediaRecorder.isTypeSupported('video/webm;codecs=h264')
      ? 'video/webm;codecs=h264'
      : 'video/webm');

  if (!webCodecsVideoEncoder) {
    const canvasStream = canvas.captureStream(fps);
    const combinedTracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

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
    recorder = new MediaRecorder(finalStream, {
      mimeType: recorderMime,
      videoBitsPerSecond: 6_500_000,
    });
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
  }

  await seekVideoTo(cutsToRender[0].sourceStart);
  if (recorder) {
    recorder.start(100);
  }

  for (let i = 0; i < cutsToRender.length; i++) {
    const cut = cutsToRender[i];
    if (Math.abs(videoEl.currentTime - cut.sourceStart) > 0.1) {
      if (recorder && recorder.state === 'recording') {
        try {
          recorder.pause();
        } catch {}
      }
      videoEl.pause();
      await seekVideoTo(cut.sourceStart);
      if (recorder && recorder.state === 'paused') {
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

        if (webCodecsVideoEncoder && webCodecsVideoEncoder.state === 'configured') {
          try {
            const timestampUs = Math.round((encodedFrameIndex * 1_000_000) / fps);
            const frame = new VideoFrame(canvas, { timestamp: timestampUs });
            webCodecsVideoEncoder.encode(frame, { keyFrame: encodedFrameIndex % 30 === 0 });
            frame.close();
            encodedFrameIndex++;
          } catch {}
        }

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

  let finalBlob: Blob;
  if (webCodecsVideoEncoder && mp4Muxer) {
    await webCodecsVideoEncoder.flush();
    webCodecsVideoEncoder.close();
    mp4Muxer.finalize();
    finalBlob = new Blob([mp4Muxer.target.buffer], { type: 'video/mp4' });
  } else if (recorder) {
    recorder.stop();
    await new Promise<void>((res) => {
      recorder!.onstop = () => res();
    });
    finalBlob = new Blob(chunks, { type: 'video/mp4' });
  } else {
    throw new Error('Export encoder failed to initialize');
  }

  onProgress?.(100);
  const downloadUrl = URL.createObjectURL(finalBlob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  const safeName = clip.name.replace(/[^a-z0-9_-]+/gi, '_');
  a.download = `${safeName}_9x16.mp4`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 5000);
}
