import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import { ArrayBufferTarget, Muxer } from 'mp4-muxer';
import { AudioMasteringPresetId, GeneratedClip, SourceVideoAsset, SubCut } from '../types/editor';
import { renderComposite9x16Frame } from './aiVideoEditorTools';
import { applyBroadcastAudioMasteringToBuffer } from './sotaStudioEngines';
import {
  evaluateUserAnchorSplineAtTime,
  getTrackingStateAtTime,
  resetLiveObjectTrackerState,
  trackSubjectSignatureInVideoFrame,
} from './subjectTracker';

/**
 * Selects the best supported H.264 / AAC MP4 MIME type for fallback MediaRecorder.
 */
function getSupportedMp4MimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  const mp4Candidates = [
    'video/mp4;codecs=avc1.64002a,mp4a.40.2',
    'video/mp4;codecs=avc1.640029,mp4a.40.2',
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
 * Decodes and stitches the exact audio segments for all `cutsToRender` offline in memory
 * (100% silent — never plays through the user's speakers).
 */
async function extractOfflineClipAudioBuffer(
  sourceArrayBuffer: ArrayBuffer,
  cutsToRender: SubCut[],
  defaultSpeed: number,
  fps: number,
  masteringPreset: AudioMasteringPresetId = 'off'
): Promise<AudioBuffer | null> {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    const tempCtx = new AudioCtx();
    let decoded: AudioBuffer;
    try {
      decoded = await tempCtx.decodeAudioData(sourceArrayBuffer.slice(0));
    } finally {
      try {
        await tempCtx.close();
      } catch {}
    }

    const sampleRate = decoded.sampleRate || 48000;
    const numChannels = Math.min(2, Math.max(1, decoded.numberOfChannels || 2));

    // Match each cut's exact output frame count so audio and video durations are 100% sample-locked
    const cutRanges = cutsToRender.map((cut) => {
      const spd = Math.max(0.25, Math.min(4.0, cut.speed || defaultSpeed || 1.0));
      const srcDur = Math.max(0.05, cut.sourceEnd - cut.sourceStart);
      const cutFrames = Math.max(1, Math.round((srcDur / spd) * fps));
      const exactOutSec = cutFrames / fps;
      const startSample = Math.max(0, Math.floor(cut.sourceStart * sampleRate));
      const outLen = Math.max(1, Math.round(exactOutSec * sampleRate));
      return { startSample, outLen, spd, audioDeleted: Boolean(cut.audioDeleted) };
    });

    const totalOutSamples = cutRanges.reduce((acc, r) => acc + r.outLen, 0);
    if (totalOutSamples <= 0) return null;

    const offlineCtx = new OfflineAudioContext(numChannels, totalOutSamples, sampleRate);
    const outBuffer = offlineCtx.createBuffer(numChannels, totalOutSamples, sampleRate);

    for (let ch = 0; ch < numChannels; ch++) {
      const srcChannel = decoded.getChannelData(Math.min(ch, decoded.numberOfChannels - 1));
      const dstChannel = outBuffer.getChannelData(ch);
      let writeOffset = 0;

      for (const range of cutRanges) {
        const { startSample, outLen, spd, audioDeleted } = range;
        if (audioDeleted) {
          // Audio segment was removed on A1 track — keep silence for this cut's duration
          writeOffset += outLen;
          continue;
        }
        if (Math.abs(spd - 1.0) < 0.01) {
          const safeEnd = Math.min(srcChannel.length, startSample + outLen);
          const slice = srcChannel.subarray(startSample, safeEnd);
          dstChannel.set(slice, writeOffset);
        } else {
          for (let i = 0; i < outLen; i++) {
            const srcIdx = Math.min(
              srcChannel.length - 1,
              startSample + Math.floor(i * spd)
            );
            dstChannel[writeOffset + i] = srcChannel[srcIdx] || 0;
          }
        }
        // Apply 4ms micro-fade at cut boundaries to eliminate any click/pop between jump cuts
        const fadeLen = Math.min(Math.floor(sampleRate * 0.004), Math.floor(outLen / 4));
        for (let f = 0; f < fadeLen; f++) {
          const gain = f / fadeLen;
          dstChannel[writeOffset + f] *= gain;
          dstChannel[writeOffset + outLen - 1 - f] *= gain;
        }
        writeOffset += outLen;
      }
    }

    if (masteringPreset && masteringPreset !== 'off') {
      return await applyBroadcastAudioMasteringToBuffer(outBuffer, masteringPreset);
    }

    return outBuffer;
  } catch (err) {
    console.warn('Offline audio extraction skipped or failed:', err);
    return null;
  }
}

/**
 * Deterministic, Zero-Drop, Frame-Accurate 9:16 MP4 Exporter powered by `mediabunny` + WebCodecs.
 *
 * Why this eliminates dropped frames and stuttering:
 * 1. Instead of playing a `<video>` element in real-time and polling with `setInterval` (which drops
 *    intermediate frames and duplicates stale frames whenever a 9:16 composite render takes >20ms),
 *    we use `mediabunny`'s `Input` demuxer + `CanvasSink.canvasesAtTimestamps(cutTimestamps)`.
 * 2. `canvasesAtTimestamps` is an offline pull generator over monotonically increasing timestamps:
 *    each compressed packet is decoded at most once in exact presentation order, and the decoder
 *    waits for our 9:16 canvas render + hardware H.264 encode before advancing to frame `f + 1`.
 */
export async function exportClipTo9x16Video(
  source: SourceVideoAsset,
  clip: GeneratedClip,
  onProgress?: (pct: number) => void
): Promise<void> {
  if (!source.url) {
    throw new Error('Please upload a video first before exporting.');
  }

  let outWidth = 1080;
  let outHeight = 1920;
  const fps = 30;
  const frameDurationUs = Math.round(1_000_000 / fps);

  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not initialize 9:16 export canvas');

  // Offscreen hidden video element — used for metadata fallback or if container requires DOM fallback
  const videoEl = document.createElement('video');
  videoEl.src = source.url;
  videoEl.muted = true;
  videoEl.volume = 0;
  videoEl.playsInline = true;
  videoEl.preload = 'auto';

  await new Promise<void>((res, rej) => {
    const onReady = () => {
      videoEl.removeEventListener('loadeddata', onReady);
      res();
    };
    videoEl.addEventListener('loadeddata', onReady);
    videoEl.onerror = () => rej(new Error('Failed to load source video for export'));
    videoEl.load();
  });

  let vw = videoEl.videoWidth || source.width || 1920;
  let vh = videoEl.videoHeight || source.height || 1080;
  const defaultSpeed = clip.playbackSpeed ?? 1.0;

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
            speed: defaultSpeed,
          },
        ];

  let liveTrackedX = clip.subjectFocus?.anchorX ?? 0.5;
  let liveTrackedY = clip.subjectFocus?.anchorY ?? 0.5;
  resetLiveObjectTrackerState(clip.subjectFocus?.templateSignature, {
    x: liveTrackedX,
    y: liveTrackedY,
  });

  const draw9x16Frame = (
    frameSource: HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas,
    sourceTime: number,
    clipRelTime: number,
    activeCut: SubCut
  ) => {
    const cutZoom = activeCut ? activeCut.zoom : clip.zoomScale;
    const cutBias = activeCut ? activeCut.cropBiasX : 0;
    const cutOffsetX = activeCut?.trackingOffsetX ?? clip.trackingOffsetX;

    let activeFocus = activeCut?.subjectFocus || clip.subjectFocus;
    if (activeFocus?.strategy === 'click-track') {
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
        const tracked = trackSubjectSignatureInVideoFrame(
          frameSource,
          liveTrackedX,
          liveTrackedY,
          activeFocus.targetColorRgb,
          activeFocus.templateSignature,
          activeFocus.trackedPath,
          sourceTime
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
      cutOffsetX + cutBias,
      clip.manualKeyframes,
      activeFocus
    );

    renderComposite9x16Frame({
      ctx,
      videoEl: frameSource,
      outW: outWidth,
      outH: outHeight,
      vw,
      vh,
      cropX: track.cropX,
      cropY: track.cropY,
      leftSubjectX: track.leftSubjectX,
      rightSubjectX: track.rightSubjectX,
      zoom: cutZoom,
      backgroundFillStyle:
        activeCut?.backgroundFillStyle ?? clip.backgroundFillStyle ?? 'blurred',
      activeClip: clip,
      activeCut,
      clipPlayheadTime: clipRelTime,
    });
  };

  /**
   * Seeks `videoEl` deterministically to a specific frame timestamp and waits until decoded.
   */
  const seekVideoToTime = async (targetTime: number) => {
    const maxDur = Math.max(0.1, (videoEl.duration || source.duration) - 0.005);
    const clamped = Math.max(0, Math.min(maxDur, targetTime));
    videoEl.pause();
    if (Math.abs(videoEl.currentTime - clamped) > 0.004) {
      await new Promise<void>((res) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          videoEl.removeEventListener('seeked', finish);
          res();
        };
        videoEl.addEventListener('seeked', finish);
        videoEl.currentTime = clamped;
        setTimeout(finish, 1500);
      });
    }
    let waitReady = 0;
    while (videoEl.readyState < 2 && waitReady < 40) {
      await new Promise<void>((r) => setTimeout(r, 15));
      waitReady++;
    }
  };

  // Pre-calculate exact frame counts for each cut
  const cutPlans = cutsToRender.map((cut) => {
    const spd = Math.max(0.25, Math.min(4.0, cut.speed || defaultSpeed || 1.0));
    const srcDur = Math.max(0.05, cut.sourceEnd - cut.sourceStart);
    const cutFrames = Math.max(1, Math.round((srcDur / spd) * fps));
    return { cut, spd, srcDur, cutFrames };
  });
  const totalClipFrames = Math.max(
    1,
    cutPlans.reduce((acc, p) => acc + p.cutFrames, 0)
  );

  // ============================================================================
  // PATH A (PRIMARY): MEDIABUNNY OFFLINE HARDWARE DECODE + WEBCODECS MP4 MUXER
  // ============================================================================
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    let encoderFailed = false;
    let mbInput: Input | null = null;
    try {
      onProgress?.(2);

      // Fetch source binary once in memory for both Mediabunny demuxing and sample-locked audio stitching
      const sourceResp = await fetch(source.url);
      const sourceArrayBuffer = await sourceResp.arrayBuffer();

      // 1. Decode and stitch audio offline in memory (100% silent, sample-locked to cutPlans)
      const stitchedAudio = await extractOfflineClipAudioBuffer(
        sourceArrayBuffer,
        cutsToRender,
        defaultSpeed,
        fps,
        clip.audioMasteringPreset || 'off'
      );

      let audioCodecConfig: {
        muxerCodec: 'aac' | 'opus';
        encoderCodec: string;
        sampleRate: number;
        numberOfChannels: number;
      } | null = null;

      if (stitchedAudio && typeof AudioEncoder !== 'undefined' && typeof AudioData !== 'undefined') {
        const sr = stitchedAudio.sampleRate;
        const ch = stitchedAudio.numberOfChannels;
        const aacCheck = await AudioEncoder.isConfigSupported({
          codec: 'mp4a.40.2',
          sampleRate: sr,
          numberOfChannels: ch,
          bitrate: 192_000,
        }).catch(() => ({ supported: false }));

        if (aacCheck.supported) {
          audioCodecConfig = {
            muxerCodec: 'aac',
            encoderCodec: 'mp4a.40.2',
            sampleRate: sr,
            numberOfChannels: ch,
          };
        } else {
          const opusCheck = await AudioEncoder.isConfigSupported({
            codec: 'opus',
            sampleRate: sr,
            numberOfChannels: ch,
            bitrate: 192_000,
          }).catch(() => ({ supported: false }));
          if (opusCheck.supported) {
            audioCodecConfig = {
              muxerCodec: 'opus',
              encoderCodec: 'opus',
              sampleRate: sr,
              numberOfChannels: ch,
            };
          }
        }
      }

      // 2. Probe 1080x1920 Full HD H.264 High Profile (10 Mbps), with automatic fallback to 720x1280 (8 Mbps)
      const codecCandidates = [
        'avc1.64002a', // High Profile Level 4.2 (1080p60 / 1080x1920)
        'avc1.640029', // High Profile Level 4.1 (1080x1920 @ 30fps)
        'avc1.4d002a', // Main Profile Level 4.2
        'avc1.4d0029', // Main Profile Level 4.1
        'avc1.42002a', // Baseline Level 4.2
        'avc1.420029', // Baseline Level 4.1
        'avc1.640028', // High Profile Level 4.0
        'avc1.4d0028',
        'avc1.420028',
        'avc1.42001f',
      ];

      let selectedVideoCodec = '';
      let targetBitrate = 10_000_000;

      for (const c of codecCandidates) {
        const sup = await VideoEncoder.isConfigSupported({
          codec: c,
          width: 1080,
          height: 1920,
          bitrate: targetBitrate,
          framerate: fps,
          hardwareAcceleration: 'prefer-hardware',
        }).catch(() => ({ supported: false }));
        if (sup.supported) {
          selectedVideoCodec = c;
          outWidth = 1080;
          outHeight = 1920;
          break;
        }
      }

      if (!selectedVideoCodec) {
        outWidth = 720;
        outHeight = 1280;
        targetBitrate = 8_000_000;
        selectedVideoCodec = 'avc1.420029';
        for (const c of codecCandidates) {
          const sup = await VideoEncoder.isConfigSupported({
            codec: c,
            width: outWidth,
            height: outHeight,
            bitrate: targetBitrate,
            framerate: fps,
          }).catch(() => ({ supported: false }));
          if (sup.supported) {
            selectedVideoCodec = c;
            break;
          }
        }
      }

      canvas.width = outWidth;
      canvas.height = outHeight;

      const target = new ArrayBufferTarget();
      const mp4Muxer = new Muxer({
        target,
        video: {
          codec: 'avc',
          width: outWidth,
          height: outHeight,
          frameRate: fps,
        },
        audio: audioCodecConfig
          ? {
              codec: audioCodecConfig.muxerCodec,
              numberOfChannels: audioCodecConfig.numberOfChannels,
              sampleRate: audioCodecConfig.sampleRate,
            }
          : undefined,
        fastStart: 'in-memory',
      });

      const videoEncoder = new VideoEncoder({
        output: (chunk, meta) => {
          mp4Muxer.addVideoChunk(chunk, meta);
        },
        error: (e) => {
          console.warn('WebCodecs VideoEncoder error:', e);
          encoderFailed = true;
        },
      });

      videoEncoder.configure({
        codec: selectedVideoCodec,
        width: outWidth,
        height: outHeight,
        bitrate: targetBitrate,
        framerate: fps,
        hardwareAcceleration: 'prefer-hardware',
      });

      // 3. Encode full stitched audio track offline
      if (stitchedAudio && audioCodecConfig) {
        try {
          const audioEncoder = new AudioEncoder({
            output: (chunk, meta) => {
              mp4Muxer.addAudioChunk(chunk, meta);
            },
            error: (e) => console.warn('WebCodecs AudioEncoder error:', e),
          });
          audioEncoder.configure({
            codec: audioCodecConfig.encoderCodec,
            sampleRate: audioCodecConfig.sampleRate,
            numberOfChannels: audioCodecConfig.numberOfChannels,
            bitrate: 192_000,
          });

          const totalSamples = stitchedAudio.length;
          const chCount = audioCodecConfig.numberOfChannels;
          const sr = audioCodecConfig.sampleRate;
          const chunkFrames = 4096;

          for (let offset = 0; offset < totalSamples; offset += chunkFrames) {
            const framesInChunk = Math.min(chunkFrames, totalSamples - offset);
            const planarData = new Float32Array(framesInChunk * chCount);
            for (let ch = 0; ch < chCount; ch++) {
              const channelSlice = stitchedAudio
                .getChannelData(ch)
                .subarray(offset, offset + framesInChunk);
              planarData.set(channelSlice, ch * framesInChunk);
            }
            const timestampUs = Math.round((offset / sr) * 1_000_000);
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: sr,
              numberOfFrames: framesInChunk,
              numberOfChannels: chCount,
              timestamp: timestampUs,
              data: planarData,
            });
            audioEncoder.encode(audioData);
            audioData.close();
          }

          await audioEncoder.flush();
          audioEncoder.close();
        } catch (audioErr) {
          console.warn('Offline audio encoding warning:', audioErr);
        }
      }

      onProgress?.(6);

      // 4. Deterministic Frame-by-Frame Pull Decoding via Mediabunny CanvasSink
      let globalFrameIndex = 0;

      const encodeCurrentCanvasFrame = async () => {
        if (encoderFailed || videoEncoder.state !== 'configured') return;
        const timestampUs = Math.round((globalFrameIndex * 1_000_000) / fps);
        const vFrame = new VideoFrame(canvas, {
          timestamp: timestampUs,
          duration: frameDurationUs,
        });
        videoEncoder.encode(vFrame, { keyFrame: globalFrameIndex % 30 === 0 });
        vFrame.close();
        globalFrameIndex++;

        // Prevent GPU surface queue overflow on Windows MediaFoundation / macOS VideoToolbox
        while (videoEncoder.encodeQueueSize > 3 && !encoderFailed) {
          await new Promise<void>((r) => setTimeout(r, 4));
        }

        if (globalFrameIndex % 3 === 0 || globalFrameIndex === totalClipFrames) {
          const pct = Math.min(
            98,
            6 + Math.round((globalFrameIndex / totalClipFrames) * 92)
          );
          onProgress?.(pct);
        }
      };

      let decodedWithMediabunny = false;
      try {
        const sourceBlob = new Blob([sourceArrayBuffer]);
        mbInput = new Input({
          source: new BlobSource(sourceBlob),
          formats: ALL_FORMATS,
        });
        const videoTrack = await mbInput.getPrimaryVideoTrack();
        if (videoTrack && (await videoTrack.canDecode())) {
          vw = videoTrack.displayWidth || vw;
          vh = videoTrack.displayHeight || vh;
          const canvasSink = new CanvasSink(videoTrack, {
            poolSize: 2,
            fit: 'fill',
          });

          let lastValidCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;

          for (const plan of cutPlans) {
            if (encoderFailed) break;
            const { cut, spd, cutFrames } = plan;

            // Monotonically sorted timestamps for this cut so Mediabunny's pipeline decodes each packet once
            const cutTimestamps: number[] = [];
            for (let f = 0; f < cutFrames; f++) {
              const srcT = Math.min(
                cut.sourceEnd,
                Math.max(0, cut.sourceStart + (f / fps) * spd)
              );
              cutTimestamps.push(srcT);
            }

            let frameInCut = 0;
            for await (const wrapped of canvasSink.canvasesAtTimestamps(cutTimestamps)) {
              if (encoderFailed) break;
              const reqSourceTime =
                cutTimestamps[frameInCut] ??
                Math.min(cut.sourceEnd, cut.sourceStart + (frameInCut / fps) * spd);
              const relClipTime =
                cut.timelineStart +
                Math.min(cut.timelineEnd - cut.timelineStart, frameInCut / fps);

              if (wrapped?.canvas) {
                lastValidCanvas = wrapped.canvas;
              }
              const frameSource = lastValidCanvas || videoEl;
              draw9x16Frame(frameSource, reqSourceTime, relClipTime, cut);
              await encodeCurrentCanvasFrame();
              frameInCut++;
            }

            // Guarantee exact sample-locked frame count if the video stream ended slightly early
            while (frameInCut < cutFrames && !encoderFailed) {
              const reqSourceTime =
                cutTimestamps[frameInCut] ?? cut.sourceEnd;
              const relClipTime =
                cut.timelineStart +
                Math.min(cut.timelineEnd - cut.timelineStart, frameInCut / fps);
              const frameSource = lastValidCanvas || videoEl;
              draw9x16Frame(frameSource, reqSourceTime, relClipTime, cut);
              await encodeCurrentCanvasFrame();
              frameInCut++;
            }
          }

          decodedWithMediabunny = true;
        }
      } catch (mbErr) {
        console.warn('Mediabunny CanvasSink decode fallback triggered:', mbErr);
      } finally {
        if (mbInput) {
          try {
            mbInput.dispose();
          } catch {}
          mbInput = null;
        }
      }

      // Deterministic Frame-Stepped Fallback (if Mediabunny did not decode all frames)
      if (!decodedWithMediabunny && !encoderFailed) {
        for (const plan of cutPlans) {
          if (encoderFailed) break;
          const { cut, spd, cutFrames } = plan;
          for (let f = 0; f < cutFrames; f++) {
            if (encoderFailed) break;
            const reqSourceTime = Math.min(
              cut.sourceEnd,
              Math.max(0, cut.sourceStart + (f / fps) * spd)
            );
            const relClipTime =
              cut.timelineStart +
              Math.min(cut.timelineEnd - cut.timelineStart, f / fps);
            await seekVideoToTime(reqSourceTime);
            draw9x16Frame(videoEl, reqSourceTime, relClipTime, cut);
            await encodeCurrentCanvasFrame();
          }
        }
      }

      if (!encoderFailed) {
        onProgress?.(99);
        await videoEncoder.flush();
        videoEncoder.close();
        mp4Muxer.finalize();

        const finalBlob = new Blob([mp4Muxer.target.buffer], { type: 'video/mp4' });
        if (finalBlob.size > 1024) {
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
          return;
        }
      } else {
        try {
          videoEncoder.close();
        } catch {}
      }
    } catch (webCodecsErr) {
      console.warn('WebCodecs export fallback triggered:', webCodecsErr);
    } finally {
      if (mbInput) {
        try {
          mbInput.dispose();
        } catch {}
      }
    }
  }

  // ============================================================================
  // PATH B (FALLBACK): SILENT MEDIARECORDER (Zero speaker output via WebAudio Destination)
  // ============================================================================
  const nativeMp4Mime = getSupportedMp4MimeType();
  const recorderMime =
    nativeMp4Mime ||
    (MediaRecorder.isTypeSupported('video/webm;codecs=h264')
      ? 'video/webm;codecs=h264'
      : 'video/webm');

  const canvasStream = canvas.captureStream(fps);
  const combinedTracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

  let silentAudioCtx: AudioContext | null = null;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      silentAudioCtx = new AudioCtx();
      videoEl.muted = false;
      videoEl.volume = 1.0;
      const sourceNode = silentAudioCtx.createMediaElementSource(videoEl);
      const streamDest = silentAudioCtx.createMediaStreamDestination();
      sourceNode.connect(streamDest);
      const audioTracks = streamDest.stream.getAudioTracks();
      if (audioTracks.length > 0) {
        combinedTracks.push(audioTracks[0]);
      }
    }
  } catch {
    videoEl.muted = true;
  }

  const finalStream = new MediaStream(combinedTracks);
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(finalStream, {
    mimeType: recorderMime,
    videoBitsPerSecond: 8_000_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  await seekVideoToTime(cutsToRender[0].sourceStart);
  recorder.start(100);

  for (let i = 0; i < cutsToRender.length; i++) {
    const cut = cutsToRender[i];
    if (Math.abs(videoEl.currentTime - cut.sourceStart) > 0.1) {
      if (recorder.state === 'recording') {
        try {
          recorder.pause();
        } catch {}
      }
      await seekVideoToTime(cut.sourceStart);
      if (recorder.state === 'paused') {
        try {
          recorder.resume();
        } catch {}
      }
    }

    videoEl.playbackRate = cut.speed || defaultSpeed || 1.0;
    await videoEl.play();

    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const t = videoEl.currentTime;
        const clipRelTime = cut.timelineStart + Math.max(0, t - cut.sourceStart);
        const pct = Math.min(
          99,
          Math.max(1, Math.round((clipRelTime / Math.max(0.5, clip.duration)) * 100))
        );
        onProgress?.(pct);
        draw9x16Frame(videoEl, t, clipRelTime, cut);

        if (t >= cut.sourceEnd - 0.015 || videoEl.ended) {
          clearInterval(timer);
          resolve();
        }
      }, 16);
    });
  }

  videoEl.pause();
  recorder.stop();
  await new Promise<void>((res) => {
    recorder.onstop = () => res();
  });
  if (silentAudioCtx) {
    try {
      await silentAudioCtx.close();
    } catch {}
  }

  const finalBlob = new Blob(chunks, { type: 'video/mp4' });
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
