// Vercel Serverless Function: /api/ai-analyze-video
// Multi-Stage AI Viral Showrunner & Common-Thread Narrative Director:
// Analyzes the full timestamped spoken transcript of the video + sampled keyframes + audio peak telemetry
// using Gemini 4 Argon (with fallback) / Claude / OpenAI to construct sentence-accurate Viral Clips
// and Common-Thread Compilation Cutdowns grounded in proven viral mechanics.

export interface TranscriptSegmentInput {
  start: number;
  end: number;
  text: string;
}

export interface AnalyzeVideoRequestPayload {
  provider: 'gemini' | 'claude' | 'openai';
  model?: string;
  apiKeyOverride?: string;
  fileName: string;
  duration: number;
  editorialFocusPrompt?: string;
  transcriptSegments?: TranscriptSegmentInput[];
  scheme: {
    name: string;
    clipCreationMode?: 'clip-segment' | 'condensed-edit';
    targetClipDuration: number;
    minClipDuration: number;
    maxClipDuration: number;
    maxClipsCount: number;
    targetAvgShotLength: number;
    pacingProfile: string;
    trackingMode: string;
    punchInZoom: number;
  };
  sceneCutTimestamps: number[];
  audioPeakTimestamps: number[];
  highEnergyWindows: Array<{ start: number; end: number; avgEnergy: number }>;
  sampledFrames: Array<{ time: number; dataUrl: string }>;
  audioSampleBase64?: string;
  audioMimeType?: string;
}

const ANALYZE_SYSTEM_PROMPT = `You are a Senior Viral Showrunner, Story Producer, and AI Narrative Director inside ClipMaker Studio.
You are given:
1) The FULL timestamped spoken transcript ("fullTranscript") across the entire video (every phrase with exact [start, end] seconds).
2) Sampled video keyframes across the timeline and audio peak telemetry.
3) The user's Editing Scheme criteria ("maxClipsCount", "clipCreationMode", "targetClipDuration") and optional "editorialFocusPrompt".

YOUR MISSION — NO BLIND MATH WINDOWS, NO SLOP, ONLY REAL NARRATIVE & PROVEN VIRAL MECHANICS:
You must deeply read and research the full transcript first to understand what the speakers are actually talking about, their stories, debates, emotional peaks, punchlines, and recurring themes.

FOLLOW THESE STRICT EDITORIAL & VIRAL MECHANICS RULES:
1) EXACT SENTENCE BOUNDARIES (NEVER CUT MID-SENTENCE):
   - Every "sourceStart" MUST match the exact "start" timestamp of a spoken sentence/phrase in "fullTranscript" (never start in the middle of a sentence or on "um / yeah so").
   - Every "sourceEnd" MUST match the exact "end" timestamp where the speaker finishes a complete thought, punchline, or payoff.

2) PROVEN VIRAL MECHANICS (HOOK → RETENTION ARC → PAYOFF):
   - First 3 Seconds (Cold Open Hook): Every clip or compilation MUST begin with a scroll-stopping hook from the transcript — a bold/contrarian statement, high-curiosity question, surprising revelation, or emotional peak that opens a curiosity gap.
   - Narrative Cohesion: Every clip must have a clear setup, escalating tension/insight, and a satisfying resolution/payoff at the end.
   - If "editorialFocusPrompt" is provided by the user, prioritize clips/compilations that match that topic, angle, or instruction.

3) MODE-SPECIFIC CONSTRUCTION ("clipCreationMode"):
   - IF "clipCreationMode" === "clip-segment" (BEST VIRAL CLIPS):
     * Find "maxClipsCount" distinct, standalone high-impact stories or arguments across different parts of the video.
     * Target duration for each clip is approximately "targetClipDuration" seconds (you may flex ±25% so the clip starts cleanly on the hook sentence and ends cleanly on the payoff sentence).
     * Keep each standalone viral clip as 1 continuous segment in "subCuts" (or 2–3 sentence-aligned subCuts ONLY if you are removing a dead-air tangent in the middle of the same story). Do NOT chop continuous speech into arbitrary 2-second slices!
   - IF "clipCreationMode" === "condensed-edit" (COMPILATION CUTDOWN):
     * Each of the "maxClipsCount" compilations MUST be built around a DISTINCT COMMON THREAD / NARRATIVE THEME discovered in the transcript (e.g. Theme #1: Central Thesis & Climax Arc; Theme #2: Every time they debate/discuss [Topic X]; Theme #3: Rapid-fire wildest takes / funniest exchanges).
     * Select 3 to 8 non-contiguous COMPLETE spoken quote segments in "subCuts" that follow that common thread and sum to approximately "targetClipDuration" seconds.
     * Every subCut in a compilation MUST be a complete spoken thought (at least 3.5 to 15 seconds long) with a clear "narrativeRole" ("Cold Open Hook", "Thematic Setup", "Rising Tension", "Key Insight", "Climax Payoff") and the actual "spokenQuote".

4) Return ONLY valid JSON matching this exact schema:
{
  "clips": [
    {
      "name": "Compelling editorial title based on actual spoken topic (never generic 'Viral Clip #1')",
      "commonThread": "The unifying theme, topic, or narrative thread connecting this clip/compilation",
      "viralMechanics": ["Curiosity-Gap Cold Open", "Contrarian Claim", "Story Payoff"],
      "viralScore": 94,
      "hookReason": "Quotes the exact opening hook line and explains why this narrative arc holds retention",
      "editorialReasoning": "Producer breakdown of why these exact transcript timestamps were chosen and how they connect",
      "captionText": "Exact opening hook line spoken in the clip",
      "sourceStart": 12.4,
      "sourceEnd": 71.8,
      "subCuts": [
        {
          "sourceStart": 12.4,
          "sourceEnd": 24.8,
          "narrativeRole": "Cold Open Hook",
          "label": "Cold Open Hook: [short topic summary]",
          "spokenQuote": "Exact words spoken in this cut"
        }
      ],
      "captions": [
        { "start": 0, "end": 2.4, "text": "Spoken transcript segment" }
      ]
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

export async function handleAnalyzeVideoRequest(body: AnalyzeVideoRequestPayload) {
  const provider = body.provider || 'gemini';
  const apiKey = resolveProviderApiKey(provider, body.apiKeyOverride);
  const defaultModel =
    provider === 'gemini'
      ? 'gemini-4-argon'
      : provider === 'claude'
        ? 'claude-3-7-sonnet-latest'
        : 'gpt-4o';
  const requestedModel = body.model || defaultModel;

  if (!apiKey) {
    return {
      liveApiUsed: false,
      error: `No ${provider.toUpperCase()} API key configured. Add ${
        provider === 'gemini'
          ? 'GEMINI_API_KEY'
          : provider === 'claude'
            ? 'ANTHROPIC_API_KEY'
            : 'OPENAI_API_KEY'
      } in .env or AI Settings to enable AI transcript & multimodal hook detection.`,
      clips: null,
    };
  }

  // Format the full timestamped transcript so the LLM can read every spoken line and exact [start, end]
  const transcriptLines = Array.isArray(body.transcriptSegments)
    ? body.transcriptSegments.map(
        (seg, idx) =>
          `#${idx + 1} [${Number(seg.start).toFixed(2)}s -> ${Number(seg.end).toFixed(2)}s]: "${seg.text}"`
      )
    : [];

  const telemetryPrompt = JSON.stringify(
    {
      fileName: body.fileName,
      totalDurationSeconds: body.duration,
      requestedClipsCount: body.scheme.maxClipsCount,
      requestedClipMode: body.scheme.clipCreationMode || 'clip-segment',
      targetClipDurationSeconds: body.scheme.targetClipDuration,
      editorialFocusPrompt:
        body.editorialFocusPrompt ||
        (body.scheme.clipCreationMode === 'condensed-edit'
          ? 'Discover distinct Common Threads across the full transcript and weave the strongest complete spoken quotes for each theme into a cohesive narrative compilation (Cold Open Hook -> Rising Context -> Climax Payoff).'
          : 'Identify the strongest standalone viral story arcs in the transcript with a scroll-stopping cold open hook sentence, clear narrative build, and complete payoff sentence.'),
      editingSchemeCriteria: body.scheme,
      fullTranscriptCount: transcriptLines.length,
      fullTranscript:
        transcriptLines.length > 0
          ? transcriptLines.join('\n')
          : 'No pre-indexed transcript available; infer from attached audio/frames.',
      highEnergyAudioWindows: (body.highEnergyWindows || []).slice(0, 16),
      detectedSceneCuts: (body.sceneCutTimestamps || []).slice(0, 40),
      frameTimestamps: (body.sampledFrames || []).map((f) => f.time),
    },
    null,
    2
  );

  try {
    if (provider === 'gemini') {
      const parts: any[] = [{ text: telemetryPrompt }];

      for (const frame of (body.sampledFrames || []).slice(0, 8)) {
        const base64Data = frame.dataUrl.includes(',')
          ? frame.dataUrl.split(',')[1]
          : frame.dataUrl;
        parts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: base64Data,
          },
        });
      }

      // Only attach raw audioSampleBase64 if we don't already have the full transcript
      if (transcriptLines.length === 0 && body.audioSampleBase64) {
        const cleanAudio = body.audioSampleBase64.includes(',')
          ? body.audioSampleBase64.split(',')[1]
          : body.audioSampleBase64;
        parts.push({
          inlineData: {
            mimeType: body.audioMimeType || 'audio/wav',
            data: cleanAudio,
          },
        });
      }

      const candidateModels = Array.from(
        new Set([requestedModel, 'gemini-4-argon', 'gemini-2.5-flash', 'gemini-2.0-flash'])
      );

      let lastErrText = '';
      for (const candidateModel of candidateModels) {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${candidateModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: ANALYZE_SYSTEM_PROMPT }] },
              contents: [{ role: 'user', parts }],
              generationConfig: {
                temperature: 0.25,
                responseMimeType: 'application/json',
              },
            }),
          }
        );

        if (!resp.ok) {
          lastErrText = await resp.text();
          continue;
        }

        const data: any = await resp.json();
        const candParts: any[] = data?.candidates?.[0]?.content?.parts || [];
        const nonThought = candParts.filter((p) => !p?.thought && typeof p?.text === 'string');
        const rawText =
          (nonThought.length > 0
            ? nonThought[nonThought.length - 1].text
            : candParts[candParts.length - 1]?.text) || '{}';
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        const raw = jsonMatch ? jsonMatch[0] : rawText;
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.clips) && parsed.clips.length > 0) {
          return {
            liveApiUsed: true,
            providerUsed: `Google Gemini (${candidateModel})`,
            clips: parsed.clips,
          };
        }
      }

      return {
        liveApiUsed: false,
        error: `Gemini API Error: ${lastErrText || 'Empty clips response'}`,
        clips: null,
      };
    }

    if (provider === 'claude') {
      const content: any[] = [{ type: 'text', text: telemetryPrompt }];
      for (const frame of (body.sampledFrames || []).slice(0, 6)) {
        const base64Data = frame.dataUrl.includes(',')
          ? frame.dataUrl.split(',')[1]
          : frame.dataUrl;
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg',
            data: base64Data,
          },
        });
      }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: requestedModel,
          max_tokens: 3000,
          system: ANALYZE_SYSTEM_PROMPT,
          messages: [{ role: 'user', content }],
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return { liveApiUsed: false, error: `Claude API Error (${resp.status}): ${errText}`, clips: null };
      }

      const data: any = await resp.json();
      const rawText = data?.content?.[0]?.text || '{}';
      const jsonMatch = rawText.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
      return {
        liveApiUsed: true,
        providerUsed: `Anthropic Claude (${requestedModel})`,
        clips: Array.isArray(parsed.clips) ? parsed.clips : null,
      };
    }

    if (provider === 'openai') {
      const content: any[] = [{ type: 'text', text: telemetryPrompt }];
      for (const frame of (body.sampledFrames || []).slice(0, 6)) {
        content.push({
          type: 'image_url',
          image_url: { url: frame.dataUrl, detail: 'low' },
        });
      }

      const resp = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: requestedModel,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
            { role: 'user', content },
          ],
          temperature: 0.25,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        return { liveApiUsed: false, error: `OpenAI API Error (${resp.status}): ${errText}`, clips: null };
      }

      const data: any = await resp.json();
      const raw = data?.choices?.[0]?.message?.content || '{}';
      const parsed = JSON.parse(raw);
      return {
        liveApiUsed: true,
        providerUsed: `OpenAI (${requestedModel})`,
        clips: Array.isArray(parsed.clips) ? parsed.clips : null,
      };
    }
  } catch (err: any) {
    return {
      liveApiUsed: false,
      error: err?.message || 'AI video analysis failed',
      clips: null,
    };
  }

  return { liveApiUsed: false, clips: null };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method Not Allowed' }));
    return;
  }

  try {
    const body: AnalyzeVideoRequestPayload =
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const result = await handleAnalyzeVideoRequest(body);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
  }
}
