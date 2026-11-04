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
 * Selects the best supported H.264 / AAC MP4 MIME type for fallback MediaRecorder.
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
 * Decodes and stitches the exact audio segments for all `cutsToRender` offline in memory
 * (100% silent — never plays through the user's speakers).
 */
async function extractOfflineClipAudioBuffer(
  sourceUrl: string,
  cutsToRender: SubCut[],
  defaultSpeed: number
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

    // Calculate total output frames across all subCuts accounting for playback speed
    const cutRanges = cutsToRender.map((cut) => {
      const spd = Math.max(0.25, Math.min(4.0, cut.speed || defaultSpeed || 1.0));
      const startSample = Math.max(0, Math.floor(cut.sourceStart * sampleRate));
      const endSample = Math.min(
        decoded.length,
        Math.max(startSample + 1, Math.floor(cut.sourceEnd * sampleRate))
      );
      const srcLen = Math.max(0, endSample - startSample);
      const outLen = Math.max(1, Math.floor(srcLen / spd));
      return { startSample, endSample, srcLen, outLen, spd };
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
        const { startSample, srcLen, outLen, spd } = range;
        if (Math.abs(spd - 1.0) < 0.01) {
          const slice = srcChannel.subarray(startSample, startSample + outLen);
          dstChannel.set(slice, writeOffset);
        } else {
          for (let i = 0; i < outLen; i++) {
            const srcIdx = Math.min(
              decoded.length - 1,
              startSample + Math.floor(i * spd)
            );
            dstChannel[writeOffset + i] = srcChannel[srcIdx] || 0;
          }
        }
        // Apply 3ms micro-fade at cut boundaries to prevent clicks
        const fadeLen = Math.min(Math.floor(sampleRate * 0.003), Math.floor(outLen / 4));
        for (let f = 0; f < fadeLen; f++) {
          const gain = f / fadeLen;
          dstChannel[writeOffset + f] *= gain;
          dstChannel[writeOffset + outLen - 1 - f] *= gain;
        }
        writeOffset += outLen;
      }
    }

    return outBuffer;
  } catch (err) {
    console.warn('Offline audio extraction skipped or failed:', err);
    return null;
  }
}

/**
 * High-speed, 100% silent (discreet) offline renderer & MP4 exporter.
 * Uses WebCodecs (`VideoEncoder` + `AudioEncoder`) + `mp4-muxer` to render frames and audio
 * as fast as hardware allows WITHOUT playing sound through the user's speakers.
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
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true }) || canvas.getContext('2d');
  if (!ctx) throw new Error('Could not initialize 9:16 export canvas');

  // Offscreen hidden video element — ALWAYS muted so export is 100% discreet and silent!
  const videoEl = document.createElement('video');
  videoEl.src = source.url;
  videoEl.muted = true;
  videoEl.volume = 0;
  videoEl.playsInline = true;
  videoEl.preload = 'auto';

  await new Promise<void>((res, rej) => {
    videoEl.onloadeddata = () => res();
    videoEl.onerror = () => rej(new Error('Failed to load source video for export'));
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

    let activeFocus = clip.subjectFocus;
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
    const clamped = Math.max(0, Math.min((videoEl.duration || source.duration) - 0.001, targetTime));
    if (Math.abs(videoEl.currentTime - clamped) < 0.008) return;
    await new Promise<void>((res) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        videoEl.removeEventListener('seeked', done);
        res();
      };
      videoEl.addEventListener('seeked', done);
      videoEl.currentTime = clamped;
      setTimeout(done, 180);
    });
  };

  // ============================================================================
  // PATH A (PRIMARY): HIGH-SPEED OFFLINE WEBCODECS + MP4-MUXER PIPELINE
  // ============================================================================
  if (typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined') {
    onProgress?.(2);

    // 1. Extract and stitch audio buffer offline (100% silent, takes ~150ms)
    const stitchedAudio = await extractOfflineClipAudioBuffer(
      source.url,
      cutsToRender,
      defaultSpeed
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

    // 2. Configure H.264 hardware VideoEncoder + MP4 Muxer
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
      error: (e) => console.warn('WebCodecs VideoEncoder error:', e),
    });

    // Pick best supported H.264 profile (High / Main / Baseline) with hardware acceleration
    const codecCandidates = ['avc1.640028', 'avc1.4d0028', 'avc1.42001f', 'avc1.42E01E'];
    let selectedVideoCodec = 'avc1.42001f';
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

    videoEncoder.configure({
      codec: selectedVideoCodec,
      width: outWidth,
      height: outHeight,
      bitrate: 6_000_000,
      framerate: fps,
      hardwareAcceleration: 'prefer-hardware',
    });

    // 3. Encode full stitched audio track offline in memory (completes in ~100ms)
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

    onProgress?.(8);

    // 4. High-Speed Offline Video Frame Rendering & Encoding
    // Build the exact frame schedule across all cuts
    interface FrameTask {
      sourceTime: number;
      clipRelTime: number;
      cut: SubCut;
    }
    const frameSchedule: FrameTask[] = [];
    let timelineCursor = 0;

    for (const cut of cutsToRender) {
      const spd = Math.max(0.25, Math.min(4.0, cut.speed || defaultSpeed || 1.0));
      const srcDur = Math.max(0.05, cut.sourceEnd - cut.sourceStart);
      const outDur = srcDur / spd;
      const cutFrames = Math.max(1, Math.round(outDur * fps));

      for (let f = 0; f < cutFrames; f++) {
        const localOutSec = f / fps;
        const sourceTime = Math.min(cut.sourceEnd, cut.sourceStart + localOutSec * spd);
        const clipRelTime = timelineCursor + localOutSec;
        frameSchedule.push({ sourceTime, clipRelTime, cut });
      }
      timelineCursor += outDur;
    }

    const totalFrames = Math.max(1, frameSchedule.length);
    const frameDurationUs = Math.round(1_000_000 / fps);

    // Benchmark first 4 seeks to decide between deterministic fast-seek vs 4x muted turbo-decode
    await seekVideoTo(frameSchedule[0].sourceTime);
    let seekTotalMs = 0;
    const probeCount = Math.min(4, frameSchedule.length - 1);
    for (let p = 1; p <= probeCount; p++) {
      const t0 = performance.now();
      await seekVideoTo(frameSchedule[p].sourceTime);
      seekTotalMs += performance.now() - t0;
    }
    const avgSeekMs = probeCount > 0 ? seekTotalMs / probeCount : 8;

    if (avgSeekMs <= 22) {
      // Deterministic High-Speed Frame-Seek Pipeline (typically 60–180 fps, 2x–6x real-time)
      for (let idx = 0; idx < totalFrames; idx++) {
        const task = frameSchedule[idx];
        await seekVideoTo(task.sourceTime);
        draw9x16Frame(task.sourceTime, task.clipRelTime, task.cut);

        const timestampUs = Math.round((idx * 1_000_000) / fps);
        const vFrame = new VideoFrame(canvas, {
          timestamp: timestampUs,
          duration: frameDurationUs,
        });
        videoEncoder.encode(vFrame, { keyFrame: idx % 30 === 0 });
        vFrame.close();

        // Keep hardware encoder queue healthy
        if (videoEncoder.encodeQueueSize > 14) {
          await new Promise<void>((r) => setTimeout(r, 4));
        }

        if (idx % 4 === 0 || idx === totalFrames - 1) {
          const pct = Math.min(98, 8 + Math.round(((idx + 1) / totalFrames) * 90));
          onProgress?.(pct);
        }
      }
    } else {
      // Long-GOP Video Container: Muted High-Speed Hardware Playback (up to 4x real-time, 100% silent)
      let encodedFrameIndex = 0;
      for (let i = 0; i < cutsToRender.length; i++) {
        const cut = cutsToRender[i];
        const spd = Math.max(0.25, Math.min(4.0, cut.speed || defaultSpeed || 1.0));
        const srcDur = Math.max(0.05, cut.sourceEnd - cut.sourceStart);
        const outDur = srcDur / spd;
        const cutFrames = Math.max(1, Math.round(outDur * fps));

        await seekVideoTo(cut.sourceStart);
        // Play muted at high speed (up to 4x) so hardware decoder streams forward frames rapidly
        const turboRate = Math.min(4.0, Math.max(1.5, spd * 3.0));
        videoEl.muted = true;
        videoEl.playbackRate = turboRate;
        try {
          await videoEl.play();
        } catch {}

        for (let f = 0; f < cutFrames; f++) {
          const targetSourceTime = Math.min(
            cut.sourceEnd,
            cut.sourceStart + (f / fps) * spd
          );
          const clipRelTime = cut.timelineStart + f / fps;

          // Wait briefly if hardware playback hasn't reached targetSourceTime yet
          let waitLoops = 0;
          while (
            !videoEl.paused &&
            !videoEl.ended &&
            videoEl.currentTime < targetSourceTime - 0.015 &&
            waitLoops < 25
          ) {
            await new Promise<void>((r) => setTimeout(r, 4));
            waitLoops++;
          }
          if (Math.abs(videoEl.currentTime - targetSourceTime) > 0.18) {
            await seekVideoTo(targetSourceTime);
          }

          draw9x16Frame(videoEl.currentTime, clipRelTime, cut);

          const timestampUs = Math.round((encodedFrameIndex * 1_000_000) / fps);
          const vFrame = new VideoFrame(canvas, {
            timestamp: timestampUs,
            duration: frameDurationUs,
          });
          videoEncoder.encode(vFrame, { keyFrame: encodedFrameIndex % 30 === 0 });
          vFrame.close();
          encodedFrameIndex++;

          if (videoEncoder.encodeQueueSize > 14) {
            await new Promise<void>((r) => setTimeout(r, 4));
          }

          if (encodedFrameIndex % 4 === 0) {
            const pct = Math.min(
              98,
              8 + Math.round((encodedFrameIndex / totalFrames) * 90)
            );
            onProgress?.(pct);
          }
        }
        videoEl.pause();
      }
    }

    onProgress?.(99);
    await videoEncoder.flush();
    videoEncoder.close();
    mp4Muxer.finalize();

    const finalBlob = new Blob([mp4Muxer.target.buffer], { type: 'video/mp4' });
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
