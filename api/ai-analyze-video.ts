// Vercel Serverless Function: /api/ai-analyze-video
// Sends real sampled video frames + extracted audio clip / waveform telemetry to
// Gemini (native multimodal audio+video frames), Claude, or OpenAI to detect real
// viral clip segments, sub-cuts, and actual spoken captions from the uploaded video.

export interface AnalyzeVideoRequestPayload {
  provider: 'gemini' | 'claude' | 'openai';
  model?: string;
  apiKeyOverride?: string;
  fileName: string;
  duration: number;
  scheme: {
    name: string;
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
  audioSampleBase64?: string; // Optional WAV/MP3 snippet for Gemini native audio transcription
  audioMimeType?: string;
}

const ANALYZE_SYSTEM_PROMPT = `You are an expert AI video editor inside ClipMaker.
You are given real frames sampled at specific timestamps from an uploaded video, along with its audio energy windows, scene cut timestamps, and the user's Editing Scheme criteria.
If audio data is attached, transcribe the actual spoken words for the captions. If no speech is audible, write accurate visual hook captions describing what is actually happening in the frames (NEVER invent unrelated text).

Return ONLY valid JSON matching this exact structure:
{
  "clips": [
    {
      "name": "Short title based on actual video content",
      "sourceStart": number (in seconds, within [0, duration]),
      "sourceEnd": number (in seconds, within [sourceStart + 4, duration]),
      "viralScore": number (70 to 99),
      "hookReason": "Why this specific segment works based on visual/audio evidence",
      "captionText": "Primary hook headline matching the real content",
      "captions": [
        { "start": number (relative to clip start, 0..clipDuration), "end": number, "text": "Spoken transcript or real visual caption" }
      ]
    }
  ]
}`;

export async function handleAnalyzeVideoRequest(body: AnalyzeVideoRequestPayload) {
  const provider = body.provider || 'gemini';
  const envKey =
    provider === 'gemini'
      ? process.env.GEMINI_API_KEY
      : provider === 'claude'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY;

  const apiKey = body.apiKeyOverride?.trim() || envKey?.trim();
  const defaultModel =
    provider === 'gemini'
      ? 'gemini-2.5-flash'
      : provider === 'claude'
        ? 'claude-3-7-sonnet-latest'
        : 'gpt-4o';
  const model = body.model || defaultModel;

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

  const telemetryPrompt = JSON.stringify({
    fileName: body.fileName,
    totalDurationSeconds: body.duration,
    editingSchemeCriteria: body.scheme,
    detectedSceneCuts: body.sceneCutTimestamps,
    detectedAudioTransients: body.audioPeakTimestamps,
    highEnergyAudioWindows: body.highEnergyWindows,
    frameTimestamps: body.sampledFrames.map((f) => f.time),
  });

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

      if (body.audioSampleBase64) {
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

      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: ANALYZE_SYSTEM_PROMPT }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: 0.2,
              responseMimeType: 'application/json',
            },
          }),
        }
      );

      if (!resp.ok) {
        const errText = await resp.text();
        return { liveApiUsed: false, error: `Gemini API Error (${resp.status}): ${errText}`, clips: null };
      }

      const data: any = await resp.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      const parsed = JSON.parse(raw);
      return {
        liveApiUsed: true,
        providerUsed: `Google Gemini (${model})`,
        clips: Array.isArray(parsed.clips) ? parsed.clips : null,
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
          model,
          max_tokens: 1800,
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
        providerUsed: `Anthropic Claude (${model})`,
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
          model,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: ANALYZE_SYSTEM_PROMPT },
            { role: 'user', content },
          ],
          temperature: 0.2,
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
        providerUsed: `OpenAI (${model})`,
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
