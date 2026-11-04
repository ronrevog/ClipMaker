// Vercel Serverless Function: /api/ai-copilot
// Multimodal Studio Agent powered by Google Gemini 4 Argon (Default), Anthropic Claude, or OpenAI.
// Has 100% full access to every control in ClipMaker Studio:
// - Caption placement (Top / Middle / Bottom / exact Y & X), Fonts (Graffiti, Marker, Bangers, Impact, Bebas, Serif, Mono, Inter),
//   Font size scale, Custom word & karaoke highlight colors, Background box opacity/color, Uppercase toggle, Show/Hide
// - Top/Custom Hook Title Banner Overlays
// - Video Color Grading & Filters (Brightness, Contrast, Saturation, B&W Grayscale, Sepia, Hue)
// - 9:16 Layouts (2-Speaker Top/Bottom Split-Screen, 2-Speaker Auto-Switch, Blurred 9:16 Background Fill, Black Letterbox)
// - Full Transcript Search & Quote Clipping, 3-Stage Viral Clips & Common-Thread Compilations
// - Vision Focus Lock Points, Zoom (0.56x Fit-16:9 .. 1.0x Full Height .. 1.5x Punch-In), Silence Stripping, Beat Cuts, Speed, Export

export interface CopilotRequestPayload {
  provider: 'gemini' | 'claude' | 'openai';
  model?: string;
  apiKeyOverride?: string;
  mode?: 'chat' | 'transcribe_audio';
  userPrompt: string;
  hasVideoLoaded?: boolean;
  sourceVideoName?: string;
  sourceDuration?: number;
  currentFrameDataUrl?: string;
  audioBase64?: string;
  audioMimeType?: string;
  audioStartOffset?: number;
  audioDuration?: number;
  transcriptExcerpt?: Array<{ start: number; end: number; text: string }>;
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
    commonThread?: string;
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
    backgroundFillStyle?: string;
    captionText: string;
    captionStyle?: string;
    captionFontFamily?: string;
    captionPositionY?: number;
    captionPositionX?: number;
    captionFontScale?: number;
    captionTextColor?: string;
    captionHighlightColor?: string;
    captionBgOpacity?: number;
    hideCaptions?: boolean;
    overlayBannerText?: string;
    videoFilter?: Record<string, number>;
    subjectFocusLabel?: string;
    cuts: Array<{ id: string; timeOffset: number; sourceStart?: number; sourceEnd?: number; label: string; zoom: number; cropCenterX: number }>;
  } | null;
  currentPlayhead: number;
  sourcePlayhead?: number;
  schemeName: string;
}

export interface CopilotOperation {
  type:
    | 'customize_captions'
    | 'set_title_banner'
    | 'set_video_filter'
    | 'search_transcript_and_clip'
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
  // Caption Customization Fields (100% live canvas control)
  captionPosition?: 'top' | 'middle' | 'bottom';
  captionPositionY?: number; // 0.08 (top) .. 0.50 (middle) .. 0.77 (bottom)
  captionPositionX?: number; // 0.18 (left) .. 0.50 (center) .. 0.82 (right)
  captionFontFamily?: 'graffiti' | 'marker' | 'bangers' | 'impact' | 'bebas' | 'serif' | 'mono' | 'inter';
  captionStyle?: 'hormozi-bold' | 'premiere-minimal' | 'neon-karaoke' | 'cinema-serif' | 'street-graffiti';
  captionFontScale?: number; // 0.5 .. 2.2
  captionTextColor?: string;
  captionHighlightColor?: string;
  captionBgColor?: string;
  captionBgOpacity?: number; // 0.0 (no box) .. 1.0
  captionUppercase?: boolean;
  hideCaptions?: boolean;
  // Title / Hook Banner Overlay Fields
  bannerText?: string;
  bannerPositionY?: number;
  bannerBgColor?: string;
  bannerTextColor?: string;
  // Video Color Grading / Filter Fields
  brightness?: number;
  contrast?: number;
  saturation?: number;
  grayscale?: number;
  sepia?: number;
  hueRotate?: number;
  // Transcript Search & Quote Clipping
  searchQuery?: string;
  editorialFocusPrompt?: string;
  // Existing Studio Fields
  clipsCount?: number;
  targetDuration?: number;
  clipMode?: 'condensed-edit' | 'clip-segment';
  avgShotLength?: number;
  pacingProfile?: 'hyper-viral' | 'balanced' | 'conversational' | 'cinematic';
  trackingMode?: 'face-speaker' | 'action-motion' | 'center-lock' | 'multi-speaker';
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

const SYSTEM_PROMPT = `You are "ClipMaker Studio Agent", an all-powerful multimodal 9:16 AI Video Director and Studio Controller powered by Gemini 4 Argon.
CRITICAL RULE: You have 100% FULL DIRECT ACCESS to EVERY visual, caption, font, placement, color, filter, layout, audio, transcript, and timeline setting in the app!
NEVER tell the user that something is "anchored" or "cannot be moved/changed". Always execute their request immediately by emitting the matching operation(s) in "operations"!

HERE ARE ALL THE STUDIO TOOLS & OPERATIONS YOU CONTROL DIRECTLY:

1. FULL CAPTION BAR POSITION, FONT, SIZE & COLOR CONTROL ("customize_captions"):
   Use "customize_captions" whenever the user asks to move the caption bar, change the font (e.g. graffiti, marker, comic, impact, serif, mono, bold), resize text, change word/highlight colors, remove the background box, or hide/show captions:
   - "captionPosition": "top" (moves caption bar to top of 9:16 screen, Y=0.14) | "middle" (center screen, Y=0.50) | "bottom" (lower third, Y=0.77)
   - "captionPositionY": exact vertical position from 0.08 (very top) to 0.90 (very bottom). (e.g. top = 0.14, upper-middle = 0.30, center = 0.50, bottom = 0.77).
   - "captionPositionX": horizontal center from 0.20 (left) to 0.50 (center) to 0.80 (right).
   - "captionFontFamily":
     * "graffiti" -> Authentic street-art graffiti spray-paint font ("Rubik Spray Paint" / "Sedgwick Ave Display")
     * "marker" -> Bold street marker font ("Permanent Marker")
     * "bangers" -> Comic / Pop punchy font ("Bangers")
     * "impact" -> Heavy headline block font ("Anton" / Impact)
     * "bebas" -> Tall viral social display font ("Bebas Neue")
     * "serif" -> Editorial luxury serif ("Playfair Display" / Georgia)
     * "mono" -> Tech code monospace ("JetBrains Mono")
     * "inter" -> Clean modern bold sans-serif ("Inter")
   - "captionStyle": "street-graffiti" | "hormozi-bold" | "neon-karaoke" | "premiere-minimal" | "cinema-serif"
   - "captionFontScale": number from 0.5 (smaller) to 2.2 (huge), default 1.0.
   - "captionTextColor": CSS/hex color for unspoken words (e.g. "#ffffff", "#fef08a", "#38bdf8").
   - "captionHighlightColor": CSS/hex color for the currently spoken karaoke word (e.g. "#ff2a85" hot pink, "#34d399" neon green, "#facc15" yellow, "#ef4444" red, "#a855f7" purple).
   - "captionBgOpacity": 0.0 (removes the dark background bar behind captions completely!) to 1.0 (solid box).
   - "captionBgColor": CSS/hex color for the caption background bar.
   - "captionUppercase": true (ALL CAPS) or false (normal case).
   - "hideCaptions": true (hide all captions) or false (show captions).

2. TOP / CUSTOM HOOK TITLE BANNER OVERLAY ("set_title_banner"):
   Use "set_title_banner" when the user wants a persistent title header, topic badge, or sticker banner on screen (e.g. "add a red title banner at the top saying 'WHY THE BEEF STARTED'", or "remove title banner"):
   - "bannerText": string (set to "" to remove)
   - "bannerPositionY": 0.06..0.90 (default 0.10 at top)
   - "bannerBgColor": e.g. "rgba(220, 38, 38, 0.92)" or "#111827"
   - "bannerTextColor": e.g. "#ffffff" or "#facc15"

3. VIDEO COLOR GRADING & VISUAL FILTERS ("set_video_filter"):
   Use "set_video_filter" when the user asks to change the video look, brightness, contrast, saturation, black & white, vintage/sepia, or warmth:
   - "brightness": 0.4..2.0 (1.0 default)
   - "contrast": 0.4..2.2 (1.0 default)
   - "saturation": 0.0..2.5 (1.0 default, 0.0 = desaturated)
   - "grayscale": 0.0..1.0 (1.0 = Black & White)
   - "sepia": 0.0..1.0
   - "hueRotate": -180..180

4. TRANSCRIPT SEARCH & QUOTE CLIPPING ("search_transcript_and_clip"):
   You are given "transcriptExcerpt" containing timestamped spoken lines from the video!
   - If the user says "jump to where he talks about [topic/quote]" or "make a clip of the part about [topic]", you can either emit "set_in_out_markers" with the exact [inPoint, outPoint] from the transcript and "extractClip": true, OR emit "search_transcript_and_clip" with "searchQuery": "keyword" and "extractClip": true.

5. 9:16 LAYOUTS, ZOOM, SUBJECT TRACKING & TIMELINE NLE TOOLS:
   - "set_layout_mode": layoutMode: "split-screen" (2-speaker top/bottom stack) | "auto-switch" (alternates camera between left & right speaker) | "blurred" (blurred 9:16 background fill) | "black" (black letterbox bars).
   - "set_zoom": zoom from 0.56 (Fit full 16:9 width) to 1.0 (100% height / no zoom) to 1.50 (punch-in zoom).
   - "set_focus_point": Vision object lock! Locate any person/object in the attached 16:9 frame and pass normalized "focusX" (0..1), "focusY" (0..1), "targetLabel".
   - "clear_focus_points": Clear manual focus locks.
   - "strip_silence": Remove dead-air pauses (>=0.85s) across the clip.
   - "beat_sync_cuts": Slice/snap cuts to audio peaks.
   - "generate_word_captions": Run full-video AI speech-to-text karaoke transcription.
   - "generate_edited_clips": Run the 3-Stage Transcript-First AI Showrunner to find Viral Clips ("clip-segment") or Common-Thread Compilations ("condensed-edit"), with optional "editorialFocusPrompt", "clipsCount", "targetDuration".
   - "set_in_out_markers": Set inPoint / outPoint (and extractClip: true to create a new clip).
   - "trim_start" / "trim_end" / "split_at_playhead" / "delete_current_cut" / "repace_cuts" / "set_playback_speed".
   - "select_clip" (clipIndex: 1, 2, 3... or targetView: "full-source") / "seek_playhead" / "playback_control" / "export_mp4" / "save_project".

Respond ONLY with valid JSON matching this schema:
{
  "reply": "Concise confirmation of the exact changes applied or answer to the user's question.",
  "operations": [
    {
      "type": "customize_captions" | "set_title_banner" | "set_video_filter" | "search_transcript_and_clip" | "generate_edited_clips" | "update_scheme" | "set_focus_point" | "clear_focus_points" | "set_in_out_markers" | "trim_start" | "trim_end" | "split_at_playhead" | "delete_current_cut" | "adjust_tracking_offset" | "adjust_smoothing" | "set_zoom" | "repace_cuts" | "update_caption" | "strip_silence" | "beat_sync_cuts" | "set_layout_mode" | "generate_word_captions" | "set_playback_speed" | "save_scheme_preset" | "center_subject" | "select_clip" | "seek_playhead" | "playback_control" | "export_mp4" | "save_project",
      "captionPosition": "top" | "middle" | "bottom" (optional),
      "captionPositionY": number (optional, 0.08..0.92),
      "captionPositionX": number (optional, 0.18..0.82),
      "captionFontFamily": "graffiti" | "marker" | "bangers" | "impact" | "bebas" | "serif" | "mono" | "inter" (optional),
      "captionStyle": "street-graffiti" | "hormozi-bold" | "neon-karaoke" | "premiere-minimal" | "cinema-serif" (optional),
      "captionFontScale": number (optional, 0.5..2.2),
      "captionTextColor": string (optional),
      "captionHighlightColor": string (optional),
      "captionBgColor": string (optional),
      "captionBgOpacity": number (optional, 0.0..1.0),
      "captionUppercase": boolean (optional),
      "hideCaptions": boolean (optional),
      "bannerText": string (optional),
      "bannerPositionY": number (optional),
      "bannerBgColor": string (optional),
      "bannerTextColor": string (optional),
      "brightness": number (optional),
      "contrast": number (optional),
      "saturation": number (optional),
      "grayscale": number (optional),
      "sepia": number (optional),
      "hueRotate": number (optional),
      "searchQuery": string (optional),
      "editorialFocusPrompt": string (optional),
      "clipsCount": number (optional),
      "targetDuration": number (optional),
      "clipMode": "condensed-edit" | "clip-segment" (optional),
      "avgShotLength": number (optional),
      "pacingProfile": "hyper-viral" | "balanced" | "conversational" | "cinematic" (optional),
      "trackingMode": "face-speaker" | "action-motion" | "center-lock" | "multi-speaker" (optional),
      "safeZoneGuide": "tiktok" | "reels" | "shorts" | "none" (optional),
      "focusX": number (optional),
      "focusY": number (optional),
      "targetLabel": string (optional),
      "strategy": "auto-salient" | "face-speaker" | "left-subject" | "right-subject" | "action-motion" | "static-lock" (optional),
      "inPoint": number (optional),
      "outPoint": number (optional),
      "extractClip": boolean (optional),
      "deltaSeconds": number (optional),
      "targetTime": number (optional),
      "offsetX": number (optional),
      "smoothing": number (optional),
      "zoom": number (optional),
      "pacingMultiplier": number (optional),
      "captionText": string (optional),
      "captionSegments": [{"start": number, "end": number, "text": string}] (optional),
      "silenceThreshold": number (optional),
      "layoutMode": "blurred" | "black" | "split-screen" | "auto-switch" (optional),
      "speed": number (optional),
      "schemePresetName": string (optional),
      "clipIndex": number (optional),
      "targetView": "full-source" | "clip" (optional),
      "playbackAction": "play" | "pause" | "loop_in_out" (optional),
      "projectName": string (optional),
      "summary": "Short badge label describing the action"
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
      const transcribePrompt = `Listen carefully to this attached WAV audio track (${audioDur.toFixed(1)} seconds long).
Transcribe the EXACT spoken dialogue verbatim from the beginning (0.0s) to the end (${audioDur.toFixed(1)}s) of this audio clip into punchy 9:16 social karaoke caption cards of 3 to 5 words each.
Rules:
1. Do NOT invent generic placeholder text. Transcribe ONLY the real words actually spoken in the audio.
2. Each segment MUST have 3 to 5 words and last between 0.9 and 2.5 seconds.
3. Timestamps ("start" and "end") MUST be in seconds relative to the start of THIS attached audio clip (between 0.0 and ${audioDur.toFixed(1)}).
4. Respond ONLY with valid JSON matching:
{
  "reply": "Transcribed verbatim speech into word-level karaoke captions.",
  "segments": [
    { "start": 0.2, "end": 1.8, "text": "exact spoken words here" }
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
              const firstStart = Number(rawSegs[0]?.start) || 0;
              const needsOffset = startOffset > 1.0 && firstStart < startOffset - 1.0;
              const alignedSegs = rawSegs.map((s: any) => ({
                start: Number(((Number(s.start) || 0) + (needsOffset ? startOffset : 0)).toFixed(2)),
                end: Number(((Number(s.end) || 1.5) + (needsOffset ? startOffset : 0)).toFixed(2)),
                text: String(s.text || '').trim(),
              }));
              return {
                providerUsed: 'Google Gemini Audio',
                modelUsed: candModel,
                liveApiUsed: true,
                reply:
                  parsed.reply ||
                  `Transcribed ${alignedSegs.length} verbatim karaoke caption cards from audio.`,
                operations: [
                  {
                    type: 'generate_word_captions',
                    captionSegments: alignedSegs,
                    summary: `Transcribed ${alignedSegs.length} Karaoke Cards`,
                  },
                ],
                transcribedSegments: alignedSegs,
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
      transcriptExcerpt: (body.transcriptExcerpt || []).slice(0, 180),
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
            text: `[EXTRACTED WAV AUDIO FROM ACTIVE TIMELINE CLIP (Start Offset: ${(body.audioStartOffset ?? 0).toFixed(1)}s, Duration: ${(body.audioDuration ?? 25).toFixed(1)}s)]:`,
          });
          userParts.push({
            inlineData: {
              mimeType: body.audioMimeType || 'audio/wav',
              data: body.audioBase64,
            },
          });
        }

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

        // Check if user is asking for web search / external research so we can enable Google Search grounding
        const wantsWebSearch =
          /\b(search|google|look\s+up|who\s+is|what\s+happened|research|fact[\s-]check|news|latest|trend)\b/i.test(
            body.userPrompt
          );

        const candidateModels = Array.from(
          new Set([model, 'gemini-4-argon', 'gemini-2.5-flash'])
        );

        for (const candModel of candidateModels) {
          const reqBody: any = {
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts: userParts }],
            generationConfig: {
              temperature: 0.2,
              ...(wantsWebSearch ? {} : { responseMimeType: 'application/json' }),
            },
            ...(wantsWebSearch ? { tools: [{ googleSearch: {} }] } : {}),
          };

          const resp = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${candModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(reqBody),
            }
          );

          if (resp.ok) {
            const data: any = await resp.json();
            const parsed = JSON.parse(extractGeminiJsonText(data));
            return {
              providerUsed: 'Google Gemini',
              modelUsed: candModel,
              liveApiUsed: true,
              reply:
                parsed.reply ||
                'Applied requested Studio operations to your timeline and 9:16 preview.',
              operations: Array.isArray(parsed.operations) ? parsed.operations : [],
            };
          }
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
            max_tokens: 1500,
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

  // Caption position & font family deterministic fallback
  const wantsTopCaption = /\b(caption|subtitle|text|words?).*\b(top|upper|up\s+top|header)\b|\b(move|put|place).*\b(top)\b/i.test(p);
  const wantsMiddleCaption = /\b(caption|subtitle|text|words?).*\b(middle|center)\b/i.test(p);
  const wantsBottomCaption = /\b(caption|subtitle|text|words?).*\b(bottom|lower)\b/i.test(p);
  const wantsGraffitiFont = /\b(graffiti|street\s*art|spray|tag\s+font)\b/i.test(p);
  const wantsMarkerFont = /\b(marker|sharpie|handwritten)\b/i.test(p);
  const wantsComicFont = /\b(comic|bangers|pop\s+font)\b/i.test(p);
  const wantsImpactFont = /\b(impact|anton|heavy\s+block)\b/i.test(p);
  const wantsSerifFont = /\b(serif|cinema\s+font|editorial\s+font)\b/i.test(p);

  if (
    wantsTopCaption ||
    wantsMiddleCaption ||
    wantsBottomCaption ||
    wantsGraffitiFont ||
    wantsMarkerFont ||
    wantsComicFont ||
    wantsImpactFont ||
    wantsSerifFont
  ) {
    const pos = wantsTopCaption ? 'top' : wantsMiddleCaption ? 'middle' : wantsBottomCaption ? 'bottom' : undefined;
    const posY = wantsTopCaption ? 0.14 : wantsMiddleCaption ? 0.5 : wantsBottomCaption ? 0.77 : undefined;
    const fontFam = wantsGraffitiFont
      ? 'graffiti'
      : wantsMarkerFont
        ? 'marker'
        : wantsComicFont
          ? 'bangers'
          : wantsImpactFont
            ? 'impact'
            : wantsSerifFont
              ? 'serif'
              : undefined;
    ops.push({
      type: 'customize_captions',
      captionPosition: pos,
      captionPositionY: posY,
      captionFontFamily: fontFam,
      captionStyle: wantsGraffitiFont ? 'street-graffiti' : undefined,
      summary: `Captions: ${[pos ? `Moved to ${pos.toUpperCase()}` : '', fontFam ? `${fontFam.toUpperCase()} Font` : ''].filter(Boolean).join(' • ')}`,
    });
    replies.push(
      `Updated captions on the 9:16 canvas (${[
        pos ? `moved caption bar to the ${pos}` : '',
        fontFam ? `applied ${fontFam} font` : '',
      ]
        .filter(Boolean)
        .join(' and ')}).`
    );
  }

  if (ops.length === 0) {
    replies.push(
      `Ready! Tell me what to adjust on your 9:16 edit — caption placement, fonts, colors, filters, splits, or cuts.`
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
