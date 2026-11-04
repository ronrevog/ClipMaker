// Vercel Serverless Function: /api/ai-copilot
// Multimodal Studio Agent powered by Google Gemini 4 Argon (Default), Anthropic Claude, or OpenAI.
// Sees the current video frame at the playhead and controls every part of ClipMaker Studio:
// clip generation, focus lock points (vision object localization), scheme settings, timeline cuts,
// In/Out markers, captions, playback/seeking, project saving, and MP4 export.

export interface CopilotRequestPayload {
  provider: 'gemini' | 'claude' | 'openai';
  model?: string;
  apiKeyOverride?: string;
  mode?: 'chat' | 'transcribe_audio';
  userPrompt: string;
  hasVideoLoaded?: boolean;
  sourceVideoName?: string;
  sourceDuration?: number;
  currentFrameDataUrl?: string; // Live JPEG frame captured from the video player at the current playhead
  audioBase64?: string; // Real extracted 8kHz mono WAV audio slice from the active clip/timeline
  audioMimeType?: string;
  audioStartOffset?: number;
  audioDuration?: number;
  attachments?: Array<{
    name: string;
    mimeType: string;
    kind: 'image' | 'video' | 'text';
    dataUrl?: string;
    videoFramesDataUrls?: string[];
    textContent?: string;
  }>;
  timelineMode?: 'full-source' | 'elected-clip';
  inMarker?: number | null;
  outMarker?: number | null;
  focusLocksCount?: number;
  generatedClipsList?: Array<{
    index: number;
    id: string;
    name: string;
    duration: number;
    sourceStart: number;
    sourceEnd: number;
  }>;
  activeScheme?: {
    id: string;
    name: string;
    clipCreationMode?: 'clip-segment' | 'condensed-edit';
    targetClipDuration: number;
    minClipDuration: number;
    maxClipDuration: number;
    maxClipsCount: number;
    targetAvgShotLength: number;
    pacingProfile: string;
    trackingMode: string;
    captionStyle: string;
    safeZoneGuide: string;
    punchInZoom: number;
    trackingSmoothing: number;
  };
  activeClip?: {
    id: string;
    name: string;
    sourceStart: number;
    sourceEnd: number;
    duration: number;
    trackingMode: string;
    trackingOffsetX: number;
    trackingSmoothing: number;
    zoomScale: number;
    captionText: string;
    subjectFocusLabel?: string;
    cuts: Array<{ id: string; timeOffset: number; label: string; zoom: number; cropCenterX: number }>;
  } | null;
  currentPlayhead: number;
  sourcePlayhead?: number;
  schemeName: string;
}

export interface CopilotOperation {
  type:
    | 'generate_edited_clips'
    | 'update_scheme'
    | 'set_focus_point'
    | 'clear_focus_points'
    | 'set_in_out_markers'
    | 'trim_start'
    | 'trim_end'
    | 'split_at_playhead'
    | 'delete_current_cut'
    | 'adjust_tracking_offset'
    | 'adjust_smoothing'
    | 'set_zoom'
    | 'repace_cuts'
    | 'update_caption'
    | 'save_scheme_preset'
    | 'center_subject'
    | 'select_clip'
    | 'seek_playhead'
    | 'playback_control'
    | 'export_mp4'
    | 'save_project'
    | 'strip_silence'
    | 'beat_sync_cuts'
    | 'set_layout_mode'
    | 'generate_word_captions'
    | 'set_playback_speed';
  clipsCount?: number;
  targetDuration?: number;
  clipMode?: 'condensed-edit' | 'clip-segment';
  avgShotLength?: number;
  pacingProfile?: 'hyper-viral' | 'balanced' | 'conversational' | 'cinematic';
  trackingMode?: 'face-speaker' | 'action-motion' | 'center-lock' | 'multi-speaker';
  captionStyle?: 'hormozi-bold' | 'premiere-minimal' | 'neon-karaoke' | 'cinema-serif';
  safeZoneGuide?: 'tiktok' | 'reels' | 'shorts' | 'none';
  focusX?: number;
  focusY?: number;
  targetLabel?: string;
  strategy?: 'auto-salient' | 'face-speaker' | 'left-subject' | 'right-subject' | 'action-motion' | 'static-lock';
  inPoint?: number;
  outPoint?: number;
  extractClip?: boolean;
  deltaSeconds?: number;
  targetTime?: number;
  offsetX?: number;
  smoothing?: number;
  zoom?: number;
  pacingMultiplier?: number;
  captionText?: string;
  captionSegments?: Array<{ start: number; end: number; text: string }>;
  silenceThreshold?: number;
  layoutMode?: 'blurred' | 'black' | 'split-screen' | 'auto-switch';
  speed?: number;
  schemePresetName?: string;
  clipIndex?: number;
  targetView?: 'full-source' | 'clip';
  playbackAction?: 'play' | 'pause' | 'loop_in_out';
  projectName?: string;
  summary: string;
}

export interface CopilotResponsePayload {
  providerUsed: string;
  modelUsed: string;
  liveApiUsed: boolean;
  reply: string;
  operations: CopilotOperation[];
  transcribedSegments?: Array<{ start: number; end: number; text: string }>;
}

const SYSTEM_PROMPT = `You are "ClipMaker Studio Agent", an expert multimodal 9:16 social video editor and studio controller powered by Gemini 4 Argon.
You are directly wired into every control in ClipMaker Studio:
1. Left Pane (Editing Scheme): targetClipDuration, maxClipsCount, clipCreationMode ("clip-segment" for continuous viral segments or "condensed-edit" for multi-cut highlight compilations), targetAvgShotLength, pacingProfile ("hyper-viral" | "balanced" | "conversational" | "cinematic"), trackingMode ("face-speaker" | "action-motion" | "center-lock" | "multi-speaker"), captionStyle ("hormozi-bold" | "premiere-minimal" | "neon-karaoke" | "cinema-serif"), safeZoneGuide ("tiktok" | "reels" | "shorts" | "none"), punchInZoom (1.0..1.5), trackingSmoothing (0.15..0.96).
2. Center Monitors (16:9 Source + 9:16 Vertical Preview):
   - When an image of the current video frame is attached, you can SEE the exact frame at the current playhead!
   - If the user asks to lock onto, track, or focus on any specific object or person visible in the frame (e.g., "lock onto the car", "track the guy in the red hoodie", "focus on the sneaker", "add a focus lock on the car"), visually locate that target in the attached 16:9 frame and emit a "set_focus_point" operation with its normalized center coordinates: "focusX" (0.0 = left edge, 0.5 = center, 1.0 = right edge) and "focusY" (0.0 = top edge, 0.5 = middle, 1.0 = bottom edge), plus "targetLabel".
   - If the user asks what is happening in the frame or asks for a caption based on the visual scene, describe or caption what you see accurately.
   - If the user pastes or attaches reference image(s), reference video frames, or text/script files in the chat:
     * When they paste a reference photo of a person/car/object and say "lock onto this" or "track this in the video", locate that matching subject in the live 16:9 video frame and emit "set_focus_point" with its normalized (focusX, focusY) coordinates.
     * When they paste a screenshot or reference video showing a 9:16 layout, caption style, or cut pacing and ask to match/copy that reference style, emit "update_scheme" (setting captionStyle, pacingProfile, avgShotLength, punchInZoom, safeZoneGuide) and/or "set_zoom".
     * When they attach a script, transcript, or notes file, use its text to set captions ("update_caption"), timecodes ("set_in_out_markers"), or answer their question.
3. Timeline & Transport Controls:
   - "generate_edited_clips": Generate viral clips ("clip-segment") or compilation cutdowns ("condensed-edit") from the uploaded video using multimodal AI analysis.
   - "set_in_out_markers": Set In (inPoint in seconds) and Out (outPoint in seconds) markers on the timeline, and set "extractClip": true if the user wants to cut/create a clip from that range.
   - "trim_start" / "trim_end": Trim or extend the active clip's start or end by deltaSeconds.
   - "split_at_playhead": Razor-cut the active clip at currentPlayhead (or targetTime).
   - "delete_current_cut": Delete the currently selected sub-cut segment.
   - "repace_cuts": Speed up (pacingMultiplier < 1, e.g. 0.7) or slow down (pacingMultiplier > 1, e.g. 1.35) sub-cuts.
   - "set_zoom": Set 9:16 zoom scale across the timeline (zoom from 0.56 to 1.50):
     * zoom: 1.0 = 100% Full Height / No Zoom (1.00x) — removes all punch-in zoom across every sub-cut on the timeline so the 9:16 crop uses 100% of the vertical height. Whenever the user asks to "remove all the zoom", "make sure all zooms are out", "100% the whole way", "no zoom", or asks why a 1.20x zoom is still on the crop box, ALWAYS emit BOTH {"type": "set_zoom", "zoom": 1.0, "summary": "Removed All Zoom (1.00x Across Timeline)"} AND {"type": "update_scheme", "zoom": 1.0, "summary": "Scheme Punch-In Zoom: 1.00x"}!
     * zoom: 0.56 = Fit Full 16:9 Width (Letterbox Mode) — zooms out wider than 1.0x so the entire horizontal 16:9 video width fits inside the 9:16 vertical frame with top/bottom letterbox bars. Emit zoom: 0.56 if the user asks to "fit the whole 16:9 frame", "fit full width", "letterbox the whole shot", or wants to zoom out wider than 1.00x so nothing on the left/right is cropped.
     * zoom: 1.05..1.50 = Punch-In Zoom — zooms in closer on the subject.
   - Note on the 16:9 Left Monitor Overlay: The blue/green rectangle on the 16:9 monitor ("Speaker / Face • 1.00x") is the live 9:16 crop window indicator showing which slice of the 16:9 video is rendered into the 9:16 vertical preview on the right.
   - "adjust_tracking_offset": Pan 9:16 crop window horizontally (-0.35 left to +0.35 right).
   - "adjust_smoothing": Set camera damping/smoothing (0.15 snappy to 0.96 ultra-smooth).
   - "center_subject": Switch focus strategy ("auto-salient" | "face-speaker" | "left-subject" | "right-subject" | "action-motion" | "static-lock").
   - "clear_focus_points": Clear all manual focus lock points and reset to auto tracking.
   - "update_caption": Set or rewrite the on-screen 9:16 social caption text.
   - "strip_silence": Auto-Editor style jump-cutter! Removes silent pauses and dead air across the active clip's timeline using audio RMS waveform analysis (optional silenceThreshold: 0.1..0.35). Use whenever the user says "remove dead air", "cut out the pauses/silence", or "jump-cut the awkward pauses".
   - "beat_sync_cuts": Snaps and slices timeline cuts to detected audio peaks and musical/speech transients. Use when the user asks to "cut to the beat", "sync cuts to audio peaks", or "make rhythmic beat cuts".
   - "set_layout_mode": Sets the 9:16 visual layout / background mode (layoutMode: "blurred" | "black" | "split-screen" | "auto-switch"):
     * "split-screen": Top/Bottom 9:16 Dual-Speaker Podcast Stack (Speaker A on top half, Speaker B on bottom half).
     * "auto-switch": Alternates camera cuts back and forth between Left Speaker and Right Speaker across the timeline.
     * "blurred": Renders a soft Gaussian-blurred 9:16 background behind zoomed-out / Fit-16:9 frames instead of black letterbox bars.
     * "black": Clean black letterbox bars when zoomed out (<1.0x).
   - "generate_word_captions": Generates word-level karaoke captions across the clip (with optional captionText or captionSegments array [{start, end, text}] and captionStyle: "hormozi-bold" | "neon-karaoke" | "premiere-minimal" | "cinema-serif"). Use when the user asks to "add word-by-word captions", "transcribe/caption this clip", or "add karaoke subtitles".
   - "set_playback_speed": Sets video & timeline playback speed (speed: 0.5 to 2.0, e.g. 1.25 for 25% faster, 0.5 for slow-mo).
   - "select_clip": Switch to a generated clip (clipIndex: 1, 2, 3...) or back to the full source video (targetView: "full-source").
   - "seek_playhead": Jump the playhead to targetTime (in seconds).
   - "playback_control": "play", "pause", or "loop_in_out".
   - "export_mp4": Export and download the active 9:16 clip as an .mp4 file.
   - "save_project": Save the current project to cloud storage (optional projectName).
   - "save_scheme_preset": Save the current scheme settings as a reusable named preset (schemePresetName).

If the user is just asking a question, chatting, or no video is loaded yet and they ask a general question, return "operations": [] (or "update_scheme" if they want to pre-configure scheme settings) and a helpful "reply".

Respond ONLY with valid JSON matching this schema:
{
  "reply": "Clear, helpful response explaining what you did or answering the user's question.",
  "operations": [
    {
      "type": "generate_edited_clips" | "update_scheme" | "set_focus_point" | "clear_focus_points" | "set_in_out_markers" | "trim_start" | "trim_end" | "split_at_playhead" | "delete_current_cut" | "adjust_tracking_offset" | "adjust_smoothing" | "set_zoom" | "repace_cuts" | "update_caption" | "strip_silence" | "beat_sync_cuts" | "set_layout_mode" | "generate_word_captions" | "set_playback_speed" | "save_scheme_preset" | "center_subject" | "select_clip" | "seek_playhead" | "playback_control" | "export_mp4" | "save_project",
      "clipsCount": number (optional, 1..12),
      "targetDuration": number (optional, 5..180 seconds),
      "clipMode": "condensed-edit" | "clip-segment" (optional),
      "avgShotLength": number (optional, 0.8..15.0 seconds),
      "pacingProfile": "hyper-viral" | "balanced" | "conversational" | "cinematic" (optional),
      "trackingMode": "face-speaker" | "action-motion" | "center-lock" | "multi-speaker" (optional),
      "captionStyle": "hormozi-bold" | "premiere-minimal" | "neon-karaoke" | "cinema-serif" (optional),
      "safeZoneGuide": "tiktok" | "reels" | "shorts" | "none" (optional),
      "focusX": number (optional, 0.05..0.95 normalized X in 16:9 frame),
      "focusY": number (optional, 0.05..0.95 normalized Y in 16:9 frame),
      "targetLabel": string (optional, e.g. "Red Sports Car"),
      "strategy": "auto-salient" | "face-speaker" | "left-subject" | "right-subject" | "action-motion" | "static-lock" (optional),
      "inPoint": number (optional, seconds),
      "outPoint": number (optional, seconds),
      "extractClip": boolean (optional),
      "deltaSeconds": number (optional),
      "targetTime": number (optional, seconds),
      "offsetX": number (optional, -0.35..0.35),
      "smoothing": number (optional, 0.15..0.96),
      "zoom": number (optional, 0.56..1.5),
      "pacingMultiplier": number (optional, 0.5..2.0),
      "captionText": string (optional),
      "captionSegments": [{"start": number, "end": number, "text": string}] (optional),
      "silenceThreshold": number (optional, 0.08..0.4),
      "layoutMode": "blurred" | "black" | "split-screen" | "auto-switch" (optional),
      "speed": number (optional, 0.5..2.0),
      "schemePresetName": string (optional),
      "clipIndex": number (optional, 1-based index of generated clip),
      "targetView": "full-source" | "clip" (optional),
      "playbackAction": "play" | "pause" | "loop_in_out" (optional),
      "projectName": string (optional),
      "summary": "Short badge label e.g. 'Focus Lock: Car (62%, 54%)' or 'Generated 4 Viral Clips (30s)'"
    }
  ]
}`;

function resolveProviderApiKey(
  provider: 'gemini' | 'claude' | 'openai',
  apiKeyOverride?: string
): string {
  const override = (apiKeyOverride || '').trim();
  if (override) return override;
  if (provider === 'gemini') {
    return (
      (process.env.GEMINI_API_KEY || '').trim() ||
      (process.env.VITE_GEMINI_API_KEY || '').trim() ||
      (process.env.GOOGLE_API_KEY || '').trim()
    );
  }
  if (provider === 'claude') {
    return (
      (process.env.ANTHROPIC_API_KEY || '').trim() ||
      (process.env.CLAUDE_API_KEY || '').trim() ||
      (process.env.VITE_ANTHROPIC_API_KEY || '').trim()
    );
  }
  return (
    (process.env.OPENAI_API_KEY || '').trim() ||
    (process.env.VITE_OPENAI_API_KEY || '').trim()
  );
}

function extractGeminiJsonText(data: any): string {
  const parts: any[] = data?.candidates?.[0]?.content?.parts || [];
  const nonThoughtParts = parts.filter((p) => !p?.thought && typeof p?.text === 'string');
  const rawText =
    (nonThoughtParts.length > 0
      ? nonThoughtParts[nonThoughtParts.length - 1].text
      : parts[parts.length - 1]?.text) || '{}';
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  return jsonMatch ? jsonMatch[0] : rawText;
}

export async function handleCopilotRequest(
  body: CopilotRequestPayload
): Promise<CopilotResponsePayload> {
  const provider = body.provider || 'gemini';
  const apiKey = resolveProviderApiKey(provider, body.apiKeyOverride);
  const defaultModel =
    provider === 'gemini'
      ? 'gemini-4-argon'
      : provider === 'claude'
        ? 'claude-3-7-sonnet-latest'
        : 'gpt-4o';
  const model = body.model || defaultModel;

  // Dedicated Real-Audio Speech-to-Text Transcription Mode (powered by Gemini Multimodal Audio)
  if (body.mode === 'transcribe_audio' && body.audioBase64) {
    const geminiKey =
      resolveProviderApiKey('gemini', provider === 'gemini' ? body.apiKeyOverride : undefined) ||
      apiKey;
    if (geminiKey) {
      const startOffset = Number(body.audioStartOffset) || 0;
      const audioDur = Number(body.audioDuration) || 30;
      const transcribePrompt = `Listen carefully to this attached WAV audio track (${audioDur.toFixed(1)} seconds long, starting at timeline offset ${startOffset.toFixed(2)}s).
Transcribe the EXACT spoken dialogue verbatim into punchy 9:16 social karaoke caption cards of 3 to 5 words each.
Rules:
1. Do NOT invent generic placeholder text. Transcribe ONLY the real words actually spoken in the audio.
2. Each segment MUST have 3 to 5 words and last between 0.9 and 2.6 seconds.
3. Timestamps ("start" and "end") MUST be in seconds relative to ${startOffset.toFixed(2)}s (so the first spoken phrase starts around ${startOffset.toFixed(2)} and ends up to ${(startOffset + audioDur).toFixed(2)}).
4. Respond ONLY with valid JSON matching:
{
  "reply": "Transcribed verbatim speech into word-level karaoke captions.",
  "segments": [
    { "start": ${startOffset.toFixed(2)}, "end": ${(startOffset + 1.8).toFixed(2)}, "text": "exact spoken words here" }
  ]
}`;

      const candidateModels = Array.from(
        new Set([
          provider === 'gemini' ? model : 'gemini-4-argon',
          'gemini-4-argon',
          'gemini-2.5-flash',
        ])
      );

      for (const candModel of candidateModels) {
        try {
          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${candModel}:generateContent?key=${encodeURIComponent(geminiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [
                  {
                    role: 'user',
                    parts: [
                      { text: transcribePrompt },
                      {
                        inlineData: {
                          mimeType: body.audioMimeType || 'audio/wav',
                          data: body.audioBase64,
                        },
                      },
                    ],
                  },
                ],
                generationConfig: {
                  temperature: 0.1,
                  responseMimeType: 'application/json',
                },
              }),
            }
          );
          if (resp.ok) {
            const data: any = await resp.json();
            const parsed = JSON.parse(extractGeminiJsonText(data));
            const rawSegs = Array.isArray(parsed.segments)
              ? parsed.segments
              : Array.isArray(parsed.captionSegments)
                ? parsed.captionSegments
                : [];
            if (rawSegs.length > 0) {
              return {
                providerUsed: 'Google Gemini Audio',
                modelUsed: candModel,
                liveApiUsed: true,
                reply:
                  parsed.reply ||
                  `Transcribed ${rawSegs.length} verbatim karaoke caption cards from audio.`,
                operations: [
                  {
                    type: 'generate_word_captions',
                    captionSegments: rawSegs,
                    summary: `Transcribed ${rawSegs.length} Karaoke Cards`,
                  },
                ],
                transcribedSegments: rawSegs,
              };
            }
          }
        } catch (err) {
          console.warn(`Audio transcription with ${candModel} failed:`, err);
        }
      }
    }
  }

  const contextMessage = JSON.stringify({
    userInstruction: body.userPrompt,
    studioState: {
      hasVideoLoaded: Boolean(body.hasVideoLoaded ?? body.activeClip),
      sourceVideoName: body.sourceVideoName || null,
      sourceDurationSeconds: body.sourceDuration || null,
      timelineMode: body.timelineMode || 'full-source',
      currentPlayheadSeconds: body.currentPlayhead,
      sourcePlayheadSeconds: body.sourcePlayhead ?? body.currentPlayhead,
      inMarkerSeconds: body.inMarker ?? null,
      outMarkerSeconds: body.outMarker ?? null,
      focusLocksCount: body.focusLocksCount ?? 0,
      hasAttachedVideoFrame: Boolean(body.currentFrameDataUrl),
      userAttachments: (body.attachments || []).map((a) => ({
        name: a.name,
        kind: a.kind,
        mimeType: a.mimeType,
        textContent: a.textContent ? a.textContent.slice(0, 12000) : undefined,
      })),
      activeEditingScheme: body.activeScheme || { name: body.schemeName },
      activeClip: body.activeClip || null,
      generatedClipsList: body.generatedClipsList || [],
    },
  });

  if (apiKey) {
    try {
      if (provider === 'gemini') {
        const userParts: any[] = [{ text: contextMessage }];
        if (body.currentFrameDataUrl && body.currentFrameDataUrl.includes('base64,')) {
          const [header, b64] = body.currentFrameDataUrl.split('base64,');
          const mimeMatch = header.match(/data:([^;]+)/);
          userParts.push({
            text: '[LIVE 16:9 VIDEO FRAME AT CURRENT PLAYHEAD]:',
          });
          userParts.push({
            inlineData: {
              mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
              data: b64,
            },
          });
        }

        if (body.audioBase64) {
          userParts.push({
            text: `[EXTRACTED WAV AUDIO FROM ACTIVE TIMELINE CLIP (Start Offset: ${(body.audioStartOffset ?? 0).toFixed(1)}s, Duration: ${(body.audioDuration ?? 25).toFixed(1)}s) — If the user asks to transcribe or add captions, transcribe the exact spoken words from this audio into "captionSegments" [{start, end, text}] with 3-5 words per card!]:`,
          });
          userParts.push({
            inlineData: {
              mimeType: body.audioMimeType || 'audio/wav',
              data: body.audioBase64,
            },
          });
        }

        // Attach any user-pasted images, reference video keyframes, or text files
        for (const att of body.attachments || []) {
          if (att.kind === 'image' && att.dataUrl && att.dataUrl.includes('base64,')) {
            const [header, b64] = att.dataUrl.split('base64,');
            const mimeMatch = header.match(/data:([^;]+)/);
            userParts.push({
              text: `[USER ATTACHED REFERENCE IMAGE: "${att.name}"]`,
            });
            userParts.push({
              inlineData: {
                mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
                data: b64,
              },
            });
          } else if (att.kind === 'video' && Array.isArray(att.videoFramesDataUrls)) {
            userParts.push({
              text: `[USER ATTACHED REFERENCE VIDEO KEYFRAMES: "${att.name}"]`,
            });
            for (const frameUrl of att.videoFramesDataUrls.slice(0, 4)) {
              if (frameUrl && frameUrl.includes('base64,')) {
                const [header, b64] = frameUrl.split('base64,');
                const mimeMatch = header.match(/data:([^;]+)/);
                userParts.push({
                  inlineData: {
                    mimeType: mimeMatch ? mimeMatch[1] : 'image/jpeg',
                    data: b64,
                  },
                });
              }
            }
          }
        }

        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: [{ role: 'user', parts: userParts }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
              },
            }),
          }
        );
        if (resp.ok) {
          const data: any = await resp.json();
          const parsed = JSON.parse(extractGeminiJsonText(data));
          return {
            providerUsed: 'Google Gemini',
            modelUsed: model,
            liveApiUsed: true,
            reply:
              parsed.reply ||
              'Applied requested Studio operations to your timeline and 9:16 framing.',
            operations: Array.isArray(parsed.operations) ? parsed.operations : [],
          };
        }
      } else if (provider === 'claude') {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: contextMessage }],
          }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const rawText = data?.content?.[0]?.text || '{}';
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
          return {
            providerUsed: 'Anthropic Claude',
            modelUsed: model,
            liveApiUsed: true,
            reply: parsed.reply || 'Applied requested edit operations to the active 9:16 clip.',
            operations: Array.isArray(parsed.operations) ? parsed.operations : [],
          };
        }
      } else if (provider === 'openai') {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: contextMessage },
            ],
            temperature: 0.2,
          }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const text = data?.choices?.[0]?.message?.content || '{}';
          const parsed = JSON.parse(text);
          return {
            providerUsed: 'OpenAI',
            modelUsed: model,
            liveApiUsed: true,
            reply: parsed.reply || 'Applied requested edit operations to the active 9:16 clip.',
            operations: Array.isArray(parsed.operations) ? parsed.operations : [],
          };
        }
      }
    } catch (err) {
      console.warn('Live AI provider call failed, using deterministic NLE engine fallback:', err);
    }
  }

  return buildDeterministicCopilotResponse(body, provider, model);
}

function buildDeterministicCopilotResponse(
  body: CopilotRequestPayload,
  provider: string,
  model: string
): CopilotResponsePayload {
  const p = body.userPrompt.toLowerCase();
  const ops: CopilotOperation[] = [];
  const replies: string[] = [];

  const minMatch = p.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  const secMatch = p.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/);
  const countMatch = p.match(/(\d+)\s*(?:clips|clip|edits|edit|videos|cutdowns)\b/);

  const parsedDuration = minMatch
    ? Math.round(parseFloat(minMatch[1]) * 60)
    : secMatch
      ? Math.round(parseFloat(secMatch[1]))
      : undefined;
  const parsedCount = countMatch ? Math.max(1, Math.min(12, parseInt(countMatch[1], 10))) : undefined;

  if (
    p.includes('viral') ||
    p.includes('compilation') ||
    p.includes('cutdown') ||
    p.includes('make clip') ||
    p.includes('make edit') ||
    p.includes('create clip') ||
    p.includes('create an edit') ||
    p.includes('create edit') ||
    p.includes('generate clip') ||
    p.includes('edited clip') ||
    p.includes('edit the video') ||
    p.includes('edit this video') ||
    p.includes('cut this video') ||
    (body.activeClip?.id === '__full_source__' && (p.includes('edit') || p.includes('clip')))
  ) {
    const mode: 'condensed-edit' | 'clip-segment' =
      p.includes('compilation') || p.includes('cutdown') || p.includes('condensed')
        ? 'condensed-edit'
        : p.includes('segment') || p.includes('viral')
          ? 'clip-segment'
          : 'condensed-edit';
    ops.push({
      type: 'generate_edited_clips',
      clipsCount: parsedCount,
      targetDuration: parsedDuration,
      clipMode: mode,
      summary: `Generated ${parsedCount ? `${parsedCount} ` : ''}${mode === 'condensed-edit' ? 'Compilations' : 'Viral Clips'}${parsedDuration ? ` (${parsedDuration}s)` : ''}`,
    });
    replies.push(
      `Generating ${parsedCount ? `${parsedCount} ` : ''}9:16 ${
        mode === 'condensed-edit' ? 'compilation cutdowns' : 'viral clips'
      }${parsedDuration ? ` (${parsedDuration}s target)` : ''} with AI analysis.`
    );
  }

  const numVal = secMatch ? parseFloat(secMatch[1]) : null;

  if (p.includes('start') || p.includes('in point') || p.includes('earlier') || p.includes('beginning')) {
    const delta = p.includes('earlier') || p.includes('extend') ? -(numVal ?? 1.5) : numVal ?? 1.5;
    ops.push({
      type: 'trim_start',
      deltaSeconds: delta,
      summary: `In Point ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s`,
    });
    replies.push(`Shifted the clip's In-Point by ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s.`);
  }

  if (p.includes('end') || p.includes('out point') || p.includes('shorter') || p.includes('trim')) {
    if (!p.includes('start')) {
      const delta = p.includes('extend') || p.includes('longer') ? numVal ?? 2.0 : -(numVal ?? 1.5);
      ops.push({
        type: 'trim_end',
        deltaSeconds: delta,
        summary: `Out Point ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s`,
      });
      replies.push(`Adjusted the Out-Point by ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s.`);
    }
  }

  if (p.includes('split') || p.includes('razor') || p.includes('cut here') || p.includes('slice')) {
    ops.push({
      type: 'split_at_playhead',
      targetTime: body.currentPlayhead,
      summary: `Razor Cut @ ${body.currentPlayhead.toFixed(2)}s`,
    });
    replies.push(`Inserted a razor cut at playhead (${body.currentPlayhead.toFixed(2)}s).`);
  }

  if (p.includes('left') || p.includes('right') || p.includes('bias') || p.includes('pan')) {
    const offset = p.includes('left') ? -0.14 : p.includes('right') ? 0.14 : 0;
    ops.push({
      type: 'adjust_tracking_offset',
      offsetX: offset,
      summary: `9:16 Crop Bias ${offset > 0 ? 'Right' : 'Left'}`,
    });
    replies.push(`Biased the 9:16 subject tracking window ${offset < 0 ? 'left (-14%)' : 'right (+14%)'}.`);
  }

  if (p.includes('center') || p.includes('recenter') || p.includes('lock') || p.includes('track')) {
    ops.push({
      type: 'center_subject',
      offsetX: 0,
      smoothing: 0.88,
      summary: 'Re-Center Subject Lock',
    });
    replies.push(`Recalibrated the 9:16 tracking solver to lock onto the primary subject centroid.`);
  }

  if (p.includes('smooth') || p.includes('jitter') || p.includes('steady') || p.includes('snappy')) {
    const smooth = p.includes('snappy') || p.includes('fast') ? 0.45 : 0.92;
    ops.push({
      type: 'adjust_smoothing',
      smoothing: smooth,
      summary: `Track Damping ${Math.round(smooth * 100)}%`,
    });
    replies.push(`Updated camera path spring damping to ${Math.round(smooth * 100)}%.`);
  }

  if (
    p.includes('zoom') ||
    p.includes('punch') ||
    p.includes('closer') ||
    p.includes('wide') ||
    p.includes('100%') ||
    p.includes('fit width') ||
    p.includes('full frame')
  ) {
    const isFitWidth =
      p.includes('fit width') || p.includes('full width') || p.includes('letterbox');
    const isZoomReset =
      p.includes('remove') ||
      p.includes('no zoom') ||
      p.includes('out') ||
      p.includes('100%') ||
      p.includes('reset') ||
      p.includes('wide');
    const zoom = isFitWidth
      ? 0.56
      : isZoomReset
        ? 1.0
        : numVal && numVal >= 0.55 && numVal <= 2.5
          ? numVal
          : 1.24;
    ops.push({
      type: 'set_zoom',
      zoom,
      summary: zoom === 1.0 ? 'Removed All Zoom (1.00x)' : `Zoom ${zoom.toFixed(2)}x`,
    });
    if (zoom <= 1.0) {
      ops.push({
        type: 'update_scheme',
        zoom: 1.0,
        summary: 'Scheme Punch-In Zoom: 1.00x',
      });
    }
    replies.push(
      zoom === 1.0
        ? 'Removed all punch-in zoom (set to 1.00x / 100%) across every cut on the timeline.'
        : `Set 9:16 zoom scale to ${zoom.toFixed(2)}x across the timeline.`
    );
  }

  if (p.includes('faster') || p.includes('slower') || p.includes('pace') || p.includes('pacing') || p.includes('beat')) {
    const mult = p.includes('slower') ? 1.35 : 0.72;
    ops.push({
      type: 'repace_cuts',
      pacingMultiplier: mult,
      summary: mult < 1 ? 'Pacing +28% Faster' : 'Pacing -35% Slower',
    });
    replies.push(`Re-computed internal sub-cuts (${mult < 1 ? 'faster hook cadence' : 'longer takes'}).`);
  }

  if (p.includes('caption') || p.includes('subtitle') || p.includes('text') || p.includes('hook')) {
    const quoted = body.userPrompt.match(/["']([^"']+)["']/);
    const newText = quoted ? quoted[1] : (body.activeClip?.captionText || 'WATCH THIS').toUpperCase() + ' 🔥';
    ops.push({
      type: 'update_caption',
      captionText: newText,
      summary: `Caption: "${newText.slice(0, 18)}..."`,
    });
    replies.push(`Updated social caption overlay to "${newText}".`);
  }

  if (p.includes('silence') || p.includes('dead air') || p.includes('pause') || p.includes('jump cut') || p.includes('jump-cut')) {
    ops.push({
      type: 'strip_silence',
      silenceThreshold: 0.18,
      summary: 'Stripped Dead Air & Pauses',
    });
    replies.push('Scanned the audio waveform and jump-cut all silent pauses and dead air out of the timeline.');
  }

  if (p.includes('split screen') || p.includes('split-screen') || p.includes('both speakers') || p.includes('top and bottom')) {
    ops.push({
      type: 'set_layout_mode',
      layoutMode: 'split-screen',
      summary: '9:16 Dual-Speaker Split-Screen',
    });
    replies.push('Switched 9:16 output to Top/Bottom Dual-Speaker Podcast Split-Screen.');
  } else if (p.includes('switch speaker') || p.includes('auto switch') || p.includes('back and forth')) {
    ops.push({
      type: 'set_layout_mode',
      layoutMode: 'auto-switch',
      summary: '2-Speaker Auto Camera Switch',
    });
    replies.push('Applied automatic Left/Right speaker switching across timeline cuts.');
  } else if (p.includes('blur') || p.includes('blurred background')) {
    ops.push({
      type: 'set_layout_mode',
      layoutMode: 'blurred',
      zoom: 0.56,
      summary: 'Fit 16:9 + Blurred 9:16 Fill',
    });
    replies.push('Enabled blurred 9:16 background fill behind the full 16:9 frame.');
  }

  if (p.includes('beat') || p.includes('sync to audio') || p.includes('transient')) {
    ops.push({
      type: 'beat_sync_cuts',
      summary: 'Beat-Synced Cuts to Audio Peaks',
    });
    replies.push('Snapped timeline sub-cuts to detected audio peaks and transients.');
  }

  if (p.includes('speed') || p.includes('slow mo') || p.includes('slow-mo') || p.includes('fast forward') || p.includes('1.25x') || p.includes('1.5x') || p.includes('2x')) {
    const spdMatch = p.match(/(\d+(?:\.\d+)?)x/);
    const spd = spdMatch ? Math.max(0.5, Math.min(2.0, parseFloat(spdMatch[1]))) : p.includes('slow') ? 0.5 : 1.25;
    ops.push({
      type: 'set_playback_speed',
      speed: spd,
      summary: `Playback Speed: ${spd.toFixed(2)}x`,
    });
    replies.push(`Set timeline playback speed to ${spd.toFixed(2)}x.`);
  }

  if (p.includes('karaoke') || p.includes('word by word') || p.includes('word-by-word') || p.includes('transcribe') || p.includes('hormozi')) {
    ops.push({
      type: 'generate_word_captions',
      captionStyle: p.includes('neon') ? 'neon-karaoke' : 'hormozi-bold',
      summary: 'Word-Level Karaoke Captions',
    });
    replies.push('Generated word-level timed karaoke captions for the active 9:16 clip.');
  }

  if (p.includes('export') || p.includes('download') || p.includes('mp4')) {
    ops.push({
      type: 'export_mp4',
      summary: 'Exporting 9:16 MP4',
    });
    replies.push('Starting 9:16 MP4 export of the active timeline clip.');
  }

  if (ops.length === 0) {
    replies.push(
      body.activeClip
        ? `Ready on "${body.activeClip.name}" at ${body.currentPlayhead.toFixed(1)}s. Ask me to lock onto any object in the frame, generate viral clips, adjust cut pacing, zoom, or export as MP4.`
        : `Ready! Upload a video or tell me how you'd like to configure your 9:16 Editing Scheme (target duration, pacing, caption style, or tracking mode).`
    );
  }

  return {
    providerUsed: provider === 'gemini' ? 'Google Gemini' : provider === 'claude' ? 'Anthropic Claude' : 'OpenAI',
    modelUsed: model,
    liveApiUsed: false,
    reply: replies.join(' '),
    operations: ops,
  };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  try {
    const body: CopilotRequestPayload =
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const result = await handleCopilotRequest(body);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
  }
}
