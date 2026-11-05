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
  sourceUrl: string,
  cutsToRender: SubCut[],
  defaultSpeed: number,
  fps: number,
  masteringPreset: AudioMasteringPresetId = 'off'
): Promise<AudioBuffer | null> {
  try {
    const resp = await fetch(sourceUrl);
    const arrayBuf = await resp.arrayBuffer();
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return null;
    const tempCtx = new AudioCtx();
    let decoded: AudioBuffer;
    try {
      decoded = await tempCtx.decodeAudioData(arrayBuf.slice(0));
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
 * Discreet (100% silent), frame-accurate 9:16 MP4 exporter.
 *
 * Why previous exports glitched or cut off early:
 * 1. Seeking (`videoEl.currentTime = t`) on every single frame flushes the browser's H.264 GOP
 *    decoder buffer on inter-frame videos, causing stale/half-decoded frames and skipped segments.
 * 2. Instead, we seek ONCE to `cut.sourceStart`, wait until the decoder frame is ready (`readyState >= 2`),
 *    and stream forward sequentially through each cut (`cut.sourceStart -> cut.sourceEnd`) with
 *    `videoEl.muted = true` (zero speaker output!) while locking output frames to exact 30fps timestamps.
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
  const frameDurationUs = Math.round(1_000_000 / fps);

  const canvas = document.createElement('canvas');
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('Could not initialize 9:16 export canvas');

  // Offscreen hidden video element — strictly muted so zero audio ever plays through speakers
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

  const vw = videoEl.videoWidth || source.width || 1920;
  const vh = videoEl.videoHeight || source.height || 1080;
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

  const draw9x16Frame = (sourceTime: number, clipRelTime: number, activeCut: SubCut) => {
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
      cutOffsetX + cutBias,
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
      backgroundFillStyle:
        activeCut?.backgroundFillStyle ?? clip.backgroundFillStyle ?? 'blurred',
      activeClip: clip,
      activeCut,
      clipPlayheadTime: clipRelTime,
    });
  };

  /**
   * Seeks `videoEl` cleanly to the start of a cut and waits until the frame is fully decoded (`readyState >= 2`).
   * Never used mid-cut so the H.264 GOP buffer is never flushed during a cut.
   */
  const seekToCutStart = async (targetTime: number) => {
    const maxDur = Math.max(0.1, (videoEl.duration || source.duration) - 0.01);
    const clamped = Math.max(0, Math.min(maxDur, targetTime));
    videoEl.pause();
    if (Math.abs(videoEl.currentTime - clamped) > 0.02) {
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
        setTimeout(finish, 2500);
      });
    }
    // Wait until the decoded frame at `clamped` is ready to be drawn
    let waitReady = 0;
    while (videoEl.readyState < 2 && waitReady < 50) {
      await new Promise<void>((r) => setTimeout(r, 20));
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
  // PATH A (PRIMARY): WEBCODECS + MP4-MUXER (100% Silent, Fast Sequential Stream)
  // ============================================================================
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    let encoderFailed = false;
    try {
      onProgress?.(2);

      // 1. Decode and stitch audio offline in memory (100% silent, sample-locked to cutPlans)
      const stitchedAudio = await extractOfflineClipAudioBuffer(
        source.url,
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
          bitrate: 128_000,
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
            bitrate: 128_000,
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

      // 2. Configure H.264 Level 4.1 / 4.0 VideoEncoder + MP4 Muxer
      // Note: Level 4.1 (avc1.640029 / avc1.4d0029 / avc1.420029) officially supports 720x1280 vertical height!
      const codecCandidates = [
        'avc1.640029',
        'avc1.4d0029',
        'avc1.420029',
        'avc1.640028',
        'avc1.4d0028',
        'avc1.420028',
        'avc1.42001f',
      ];
      let selectedVideoCodec = 'avc1.420029';
      for (const c of codecCandidates) {
        const sup = await VideoEncoder.isConfigSupported({
          codec: c,
          width: outWidth,
          height: outHeight,
          bitrate: 6_000_000,
          framerate: fps,
        }).catch(() => ({ supported: false }));
        if (sup.supported) {
          selectedVideoCodec = c;
          break;
        }
      }

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
        bitrate: 6_000_000,
        framerate: fps,
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
            bitrate: 128_000,
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

      // 4. Sequential Forward Hardware Decoding per SubCut (Zero Mid-Cut Seeks, Zero Glitches, Full Duration)
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
        while (videoEncoder.encodeQueueSize > 4 && !encoderFailed) {
          await new Promise<void>((r) => setTimeout(r, 5));
        }

        if (globalFrameIndex % 3 === 0 || globalFrameIndex === totalClipFrames) {
          const pct = Math.min(
            98,
            6 + Math.round((globalFrameIndex / totalClipFrames) * 92)
          );
          onProgress?.(pct);
        }
      };

      for (const plan of cutPlans) {
        if (encoderFailed) break;
        const { cut, spd, cutFrames } = plan;

        // Seek ONCE to the start of this cut and wait for decoded frame readiness
        await seekToCutStart(cut.sourceStart);

        // Draw and encode the initial frame of this cut immediately
        let encodedInCut = 0;
        draw9x16Frame(cut.sourceStart, cut.timelineStart, cut);
        await encodeCurrentCanvasFrame();
        encodedInCut = 1;

        if (cutFrames > 1) {
          // Stream forward sequentially at 1.6x muted speed so the H.264 decoder never drops a P/B frame
          // and never flushes its reference buffer mid-cut!
          const renderPlaybackRate = Math.min(2.0, Math.max(1.0, spd * 1.6));
          videoEl.muted = true;
          videoEl.volume = 0;
          videoEl.playbackRate = renderPlaybackRate;

          try {
            await videoEl.play();
          } catch {}

          await new Promise<void>((resolveCut) => {
            let busy = false;
            const timer = setInterval(async () => {
              if (busy) return;
              busy = true;
              try {
                if (encoderFailed) {
                  clearInterval(timer);
                  resolveCut();
                  return;
                }

                const curSourceTime = videoEl.currentTime;
                const elapsedSrc = Math.max(0, curSourceTime - cut.sourceStart);
                const elapsedOutSec = elapsedSrc / spd;
                const targetFramesNow = Math.min(
                  cutFrames,
                  Math.floor(elapsedOutSec * fps) + 1
                );

                if (targetFramesNow > encodedInCut) {
                  const relClipTime =
                    cut.timelineStart + Math.min(cut.timelineEnd - cut.timelineStart, elapsedOutSec);
                  draw9x16Frame(curSourceTime, relClipTime, cut);

                  while (encodedInCut < targetFramesNow && !encoderFailed) {
                    await encodeCurrentCanvasFrame();
                    encodedInCut++;
                  }
                }

                // Resume playback if browser paused it before reaching cut.sourceEnd
                if (
                  videoEl.paused &&
                  !videoEl.ended &&
                  curSourceTime < cut.sourceEnd - 0.03 &&
                  encodedInCut < cutFrames
                ) {
                  videoEl.play().catch(() => {});
                }

                // Cut is complete when we have reached cut.sourceEnd or encoded all frames for this cut
                if (
                  encodedInCut >= cutFrames ||
                  curSourceTime >= cut.sourceEnd - 0.015 ||
                  videoEl.ended
                ) {
                  clearInterval(timer);
                  resolveCut();
                }
              } finally {
                busy = false;
              }
            }, 10);
          });

          videoEl.pause();

          // Ensure exact frame count for this cut so audio/video stay 100% sample-locked
          if (encodedInCut < cutFrames && !encoderFailed) {
            draw9x16Frame(
              Math.min(cut.sourceEnd, videoEl.currentTime),
              cut.timelineEnd,
              cut
            );
            while (encodedInCut < cutFrames && !encoderFailed) {
              await encodeCurrentCanvasFrame();
              encodedInCut++;
            }
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

  // Route audio into MediaStreamDestination WITHOUT connecting to audioCtx.destination
  // so the export captures full audio while remaining 100% silent on the user's speakers!
  let silentAudioCtx: AudioContext | null = null;
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (AudioCtx) {
      silentAudioCtx = new AudioCtx();
      videoEl.muted = false;
      videoEl.volume = 1.0;
      const sourceNode = silentAudioCtx.createMediaElementSource(videoEl);
      const streamDest = silentAudioCtx.createMediaStreamDestination();
      sourceNode.connect(streamDest); // Intentionally NOT connected to silentAudioCtx.destination!
      const audioTracks = streamDest.stream.getAudioTracks();
      if (audioTracks.length > 0) {
        combinedTracks.push(audioTracks[0]);
      }
    }
  } catch (e) {
    videoEl.muted = true;
  }

  const finalStream = new MediaStream(combinedTracks);
  const chunks: BlobPart[] = [];
  const recorder = new MediaRecorder(finalStream, {
    mimeType: recorderMime,
    videoBitsPerSecond: 6_500_000,
  });
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  await seekToCutStart(cutsToRender[0].sourceStart);
  recorder.start(100);

  for (let i = 0; i < cutsToRender.length; i++) {
    const cut = cutsToRender[i];
    if (Math.abs(videoEl.currentTime - cut.sourceStart) > 0.1) {
      if (recorder.state === 'recording') {
        try {
          recorder.pause();
        } catch {}
      }
      await seekToCutStart(cut.sourceStart);
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
        draw9x16Frame(t, clipRelTime, cut);

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
