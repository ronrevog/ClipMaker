// Vercel Serverless Function: /api/ai-style-clone
// Analyzes reference video telemetry + sampled keyframe strip via Gemini (Default), Claude, or OpenAI
// to synthesize a reusable EditingScheme that mimics the reference video's editing style.

export interface StyleCloneRequestPayload {
  provider: 'gemini' | 'claude' | 'openai';
  model?: string;
  apiKeyOverride?: string;
  referenceFileName: string;
  userNotes?: string;
  telemetry: {
    durationSeconds: number;
    detectedCutCount: number;
    averageShotLength: number;
    cutsPerMinute: number;
    hookCutSpeedRatio: number; // < 1 means faster cuts in first 5s
    beatSyncRatio: number; // 0..1 how many cuts align with audio peaks
    estimatedZoomIntensity: number; // 1.0..1.4
    motionEnergyScore: number; // 0..100
    silenceRatio: number; // 0..1
    aspectRatio: string;
  };
  keyframesBase64?: string[]; // Up to 4 compact JPEG data URLs sampled from reference cuts
}

export interface SynthesizedSchemePayload {
  providerUsed: string;
  modelUsed: string;
  liveApiUsed: boolean;
  styleSummary: string;
  scheme: {
    name: string;
    description: string;
    targetClipDuration: number;
    minClipDuration: number;
    maxClipDuration: number;
    maxClipsCount: number;
    pacingProfile: 'hyper-fast' | 'fast-social' | 'balanced' | 'cinematic';
    targetAvgShotLength: number;
    audioPeakWeight: number;
    visualMotionWeight: number;
    silenceThresholdMs: number;
    trackingMode: 'face-speaker' | 'primary-subject' | 'action-motion' | 'center-lock';
    trackingSmoothing: number;
    trackingDeadzone: number;
    punchInZoom: number;
    beatSyncCuts: boolean;
    captionStyle: 'hormozi-bold' | 'premiere-minimal' | 'neon-karaoke' | 'cinema-serif';
    safeZoneGuide: 'tiktok' | 'reels' | 'shorts' | 'none';
  };
}

const STYLE_CLONE_PROMPT = `You are an elite Hollywood & Viral Short-Form Video Editor.
Analyze the provided reference video telemetry and sampled keyframes to reverse-engineer its exact editing style into a reusable ClipMaker Editing Scheme.
Respond ONLY with valid JSON matching this schema:
{
  "styleSummary": "2-sentence technical breakdown of the reference video's cut cadence, hook speed, zoom energy, and framing signature.",
  "scheme": {
    "name": "Descriptive name for the cloned scheme",
    "description": "Concise summary of when to use this cloned style",
    "targetClipDuration": number (15 to 60),
    "minClipDuration": number (8 to 30),
    "maxClipDuration": number (20 to 90),
    "maxClipsCount": number (3 to 8),
    "pacingProfile": "hyper-fast" | "fast-social" | "balanced" | "cinematic",
    "targetAvgShotLength": number (0.8 to 8.0),
    "audioPeakWeight": number (0.1 to 1.0),
    "visualMotionWeight": number (0.1 to 1.0),
    "silenceThresholdMs": number (150 to 900),
    "trackingMode": "face-speaker" | "primary-subject" | "action-motion" | "center-lock",
    "trackingSmoothing": number (0.3 to 0.96),
    "trackingDeadzone": number (0.02 to 0.25),
    "punchInZoom": number (1.0 to 1.4),
    "beatSyncCuts": boolean,
    "captionStyle": "hormozi-bold" | "premiere-minimal" | "neon-karaoke" | "cinema-serif",
    "safeZoneGuide": "tiktok" | "reels" | "shorts" | "none"
  }
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

export async function handleStyleCloneRequest(
  body: StyleCloneRequestPayload
): Promise<SynthesizedSchemePayload> {
  const provider = body.provider || 'gemini';
  const apiKey = resolveProviderApiKey(provider, body.apiKeyOverride);
  const defaultModel =
    provider === 'gemini'
      ? 'gemini-2.5-flash'
      : provider === 'claude'
        ? 'claude-3-7-sonnet-latest'
        : 'gpt-4o';
  const model = body.model || defaultModel;

  const textPrompt = JSON.stringify({
    referenceVideoName: body.referenceFileName,
    userStyleNotes: body.userNotes || 'Copy the exact pacing, zoom energy, and subject framing style.',
    extractedTelemetry: body.telemetry,
  });

  if (apiKey) {
    try {
      if (provider === 'gemini') {
        const parts: any[] = [{ text: textPrompt }];
        for (const frame of (body.keyframesBase64 || []).slice(0, 4)) {
          const base64Data = frame.includes(',') ? frame.split(',')[1] : frame;
          parts.push({
            inlineData: {
              mimeType: 'image/jpeg',
              data: base64Data,
            },
          });
        }
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: STYLE_CLONE_PROMPT }] },
              contents: [{ role: 'user', parts }],
              generationConfig: {
                temperature: 0.25,
                responseMimeType: 'application/json',
              },
            }),
          }
        );
        if (resp.ok) {
          const data: any = await resp.json();
          const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          const parsed = JSON.parse(raw);
          if (parsed?.scheme) {
            return {
              providerUsed: 'Google Gemini',
              modelUsed: model,
              liveApiUsed: true,
              styleSummary: parsed.styleSummary || 'Extracted reference editing signature via Gemini.',
              scheme: parsed.scheme,
            };
          }
        }
      } else if (provider === 'claude') {
        const content: any[] = [{ type: 'text', text: textPrompt }];
        for (const frame of (body.keyframesBase64 || []).slice(0, 4)) {
          const base64Data = frame.includes(',') ? frame.split(',')[1] : frame;
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
            max_tokens: 1200,
            system: STYLE_CLONE_PROMPT,
            messages: [{ role: 'user', content }],
          }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const rawText = data?.content?.[0]?.text || '{}';
          const jsonMatch = rawText.match(/\{[\s\S]*\}/);
          const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : rawText);
          if (parsed?.scheme) {
            return {
              providerUsed: 'Anthropic Claude',
              modelUsed: model,
              liveApiUsed: true,
              styleSummary: parsed.styleSummary || 'Extracted reference editing signature via Claude.',
              scheme: parsed.scheme,
            };
          }
        }
      } else if (provider === 'openai') {
        const content: any[] = [{ type: 'text', text: textPrompt }];
        for (const frame of (body.keyframesBase64 || []).slice(0, 4)) {
          const dataUrl = frame.startsWith('data:') ? frame : `data:image/jpeg;base64,${frame}`;
          content.push({
            type: 'image_url',
            image_url: { url: dataUrl, detail: 'low' },
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
              { role: 'system', content: STYLE_CLONE_PROMPT },
              { role: 'user', content },
            ],
            temperature: 0.25,
          }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          const raw = data?.choices?.[0]?.message?.content || '{}';
          const parsed = JSON.parse(raw);
          if (parsed?.scheme) {
            return {
              providerUsed: 'OpenAI',
              modelUsed: model,
              liveApiUsed: true,
              styleSummary: parsed.styleSummary || 'Extracted reference editing signature via OpenAI.',
              scheme: parsed.scheme,
            };
          }
        }
      }
    } catch (err) {
      console.warn('Live AI style clone failed, falling back to telemetry synthesizer:', err);
    }
  }

  // Deterministic synthesis from measured reference video telemetry
  const t = body.telemetry;
  const cleanName = body.referenceFileName.replace(/\.[^/.]+$/, '');
  const asl = Math.max(0.9, Math.min(7.5, Number(t.averageShotLength.toFixed(2))));
  const pacingProfile: 'hyper-fast' | 'fast-social' | 'balanced' | 'cinematic' =
    asl < 1.6 ? 'hyper-fast' : asl < 2.6 ? 'fast-social' : asl < 4.2 ? 'balanced' : 'cinematic';

  const targetDuration = Math.round(Math.max(15, Math.min(60, t.durationSeconds || 28)));
  const trackingMode =
    t.motionEnergyScore > 65
      ? 'action-motion'
      : t.cutsPerMinute > 24
        ? 'face-speaker'
        : 'primary-subject';

  return {
    providerUsed: provider === 'gemini' ? 'Google Gemini' : provider === 'claude' ? 'Anthropic Claude' : 'OpenAI',
    modelUsed: model,
    liveApiUsed: false,
    styleSummary: `Cloned from "${body.referenceFileName}": detected ${t.detectedCutCount} cuts (${asl}s Average Shot Length, ${t.cutsPerMinute.toFixed(1)} cuts/min) with ${Math.round(t.beatSyncRatio * 100)}% audio-transient alignment and ${t.estimatedZoomIntensity.toFixed(2)}x emphasis punch-ins.`,
    scheme: {
      name: `Cloned: ${cleanName}`,
      description: `Style cloned from ${body.referenceFileName} (${asl}s ASL, ${Math.round(t.beatSyncRatio * 100)}% beat-sync, ${t.motionEnergyScore}% motion energy).`,
      targetClipDuration: targetDuration,
      minClipDuration: Math.max(8, Math.round(targetDuration * 0.6)),
      maxClipDuration: Math.min(90, Math.round(targetDuration * 1.35)),
      maxClipsCount: 4,
      pacingProfile,
      targetAvgShotLength: asl,
      audioPeakWeight: Number(Math.max(0.3, Math.min(0.95, t.beatSyncRatio)).toFixed(2)),
      visualMotionWeight: Number(Math.max(0.25, Math.min(0.95, t.motionEnergyScore / 100)).toFixed(2)),
      silenceThresholdMs: t.silenceRatio > 0.2 ? 260 : 420,
      trackingMode,
      trackingSmoothing: asl < 2.0 ? 0.68 : 0.86,
      trackingDeadzone: asl < 2.0 ? 0.06 : 0.1,
      punchInZoom: Number(Math.max(1.05, Math.min(1.38, t.estimatedZoomIntensity)).toFixed(2)),
      beatSyncCuts: t.beatSyncRatio >= 0.45,
      captionStyle: asl < 2.2 ? 'hormozi-bold' : asl < 3.5 ? 'neon-karaoke' : 'premiere-minimal',
      safeZoneGuide: 'tiktok',
    },
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
    const body: StyleCloneRequestPayload =
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const result = await handleStyleCloneRequest(body);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err?.message || 'Internal Server Error' }));
  }
}
