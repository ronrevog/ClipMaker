// Vercel Serverless Function: /api/ai-copilot
// Supports Google Gemini (Default), Anthropic Claude, and OpenAI for iterative cut feedback

export interface CopilotRequestPayload {
  provider: 'gemini' | 'claude' | 'openai';
  model?: string;
  apiKeyOverride?: string;
  userPrompt: string;
  activeClip: {
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
    cuts: Array<{ id: string; timeOffset: number; label: string; zoom: number; cropCenterX: number }>;
  };
  currentPlayhead: number;
  schemeName: string;
}

export interface CopilotOperation {
  type:
    | 'generate_edited_clips'
    | 'trim_start'
    | 'trim_end'
    | 'split_at_playhead'
    | 'adjust_tracking_offset'
    | 'adjust_smoothing'
    | 'set_zoom'
    | 'repace_cuts'
    | 'update_caption'
    | 'save_scheme_preset'
    | 'center_subject';
  clipsCount?: number;
  targetDuration?: number;
  clipMode?: 'condensed-edit' | 'clip-segment';
  deltaSeconds?: number;
  targetTime?: number;
  offsetX?: number;
  smoothing?: number;
  zoom?: number;
  pacingMultiplier?: number;
  captionText?: string;
  schemePresetName?: string;
  summary: string;
}

export interface CopilotResponsePayload {
  providerUsed: string;
  modelUsed: string;
  liveApiUsed: boolean;
  reply: string;
  operations: CopilotOperation[];
}

const SYSTEM_PROMPT = `You are "Cut Copilot", an expert 9:16 social video editor embedded inside ClipMaker Studio.
The user is either viewing the Full Uploaded Video or a specific 9:16 clip on the timeline.
If the user asks to make/create/generate edited clips (or segments) from the video (e.g., "make 3 edited clips of 60s", "create an edit of the video", "make clips from this video"), include a "generate_edited_clips" operation with the desired clipsCount (1..12), targetDuration (5..180 seconds), and clipMode ("condensed-edit" for edited highlight montages or "clip-segment" for continuous segments).

Respond ONLY with valid JSON matching this schema:
{
  "reply": "Concise, professional video editor confirmation explaining the exact clips generated or timecode/framing/cut adjustments made.",
  "operations": [
    {
      "type": "generate_edited_clips" | "trim_start" | "trim_end" | "split_at_playhead" | "adjust_tracking_offset" | "adjust_smoothing" | "set_zoom" | "repace_cuts" | "update_caption" | "save_scheme_preset" | "center_subject",
      "clipsCount": number (optional, 1..12 when generating clips),
      "targetDuration": number (optional, 5..180 seconds when generating clips),
      "clipMode": "condensed-edit" | "clip-segment" (optional),
      "deltaSeconds": number (optional, e.g. -1.5 to start 1.5s earlier or trim 1.5s),
      "targetTime": number (optional, timestamp in seconds),
      "offsetX": number (optional, -0.35 to +0.35 horizontal 9:16 crop bias),
      "smoothing": number (optional, 0.05 to 0.98 camera damping),
      "zoom": number (optional, 1.0 to 1.6 scale),
      "pacingMultiplier": number (optional, e.g. 0.7 for 30% faster cuts, 1.3 for slower cuts),
      "captionText": string (optional, updated hook/caption text),
      "schemePresetName": string (optional, if user asks to save as a scheme),
      "summary": "Short badge label e.g. 'Generated 4 Edited Clips (30s)' or 'Trim In -1.5s'"
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

export async function handleCopilotRequest(body: CopilotRequestPayload): Promise<CopilotResponsePayload> {
  const provider = body.provider || 'gemini';
  const envKey =
    provider === 'gemini'
      ? process.env.GEMINI_API_KEY
      : provider === 'claude'
        ? process.env.ANTHROPIC_API_KEY
        : process.env.OPENAI_API_KEY;

  const apiKey = resolveProviderApiKey(provider, body.apiKeyOverride) || envKey?.trim();
  const defaultModel =
    provider === 'gemini'
      ? 'gemini-4-argon'
      : provider === 'claude'
        ? 'claude-3-7-sonnet-latest'
        : 'gpt-4o';
  const model = body.model || defaultModel;

  const contextMessage = JSON.stringify({
    userFeedback: body.userPrompt,
    activeClip: body.activeClip,
    currentPlayheadSeconds: body.currentPlayhead,
    activeEditingScheme: body.schemeName,
  });

  if (apiKey) {
    try {
      if (provider === 'gemini') {
        const resp = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
              contents: [{ role: 'user', parts: [{ text: contextMessage }] }],
              generationConfig: {
                temperature: 0.2,
                responseMimeType: 'application/json',
              },
            }),
          }
        );
        if (resp.ok) {
          const data: any = await resp.json();
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          const parsed = JSON.parse(text);
          return {
            providerUsed: 'Google Gemini',
            modelUsed: model,
            liveApiUsed: true,
            reply: parsed.reply || 'Applied requested edit operations to the active 9:16 clip.',
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

  // Parse minutes or seconds if mentioned (e.g. "2 mins", "90s", "45 seconds")
  const minMatch = p.match(/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/);
  const secMatch = p.match(/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/);
  const countMatch = p.match(/(\d+)\s*(?:clips|clip|edits|edit|videos)\b/);

  const parsedDuration = minMatch
    ? Math.round(parseFloat(minMatch[1]) * 60)
    : secMatch
      ? Math.round(parseFloat(secMatch[1]))
      : undefined;
  const parsedCount = countMatch ? Math.max(1, Math.min(12, parseInt(countMatch[1], 10))) : undefined;

  if (
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
    (body.activeClip.id === '__full_source__' && (p.includes('edit') || p.includes('clip')))
  ) {
    const mode: 'condensed-edit' | 'clip-segment' =
      p.includes('segment') && !p.includes('edit') ? 'clip-segment' : 'condensed-edit';
    ops.push({
      type: 'generate_edited_clips',
      clipsCount: parsedCount,
      targetDuration: parsedDuration,
      clipMode: mode,
      summary: `Generated ${parsedCount ? `${parsedCount} ` : ''}${mode === 'condensed-edit' ? 'Edited Clips' : 'Segment Clips'}${parsedDuration ? ` (${parsedDuration}s)` : ''}`,
    });
    replies.push(
      `Generated ${parsedCount ? `${parsedCount} ` : ''}9:16 ${
        mode === 'condensed-edit' ? 'condensed highlight edits' : 'segment clips'
      }${parsedDuration ? ` of ${parsedDuration}s each` : ''} from your uploaded video and loaded Edit #1 onto the timeline.`
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
    replies.push(
      `Shifted the clip's In-Point by ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s.`
    );
  }

  if (p.includes('end') || p.includes('out point') || p.includes('shorter') || p.includes('trim')) {
    if (!p.includes('start')) {
      const delta = p.includes('extend') || p.includes('longer') ? numVal ?? 2.0 : -(numVal ?? 1.5);
      ops.push({
        type: 'trim_end',
        deltaSeconds: delta,
        summary: `Out Point ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s`,
      });
      replies.push(
        `Adjusted the Out-Point by ${delta > 0 ? '+' : ''}${delta.toFixed(1)}s to tighten the clip ending.`
      );
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
    replies.push(
      `Biased the 9:16 subject tracking window ${offset < 0 ? 'left (-14%)' : 'right (+14%)'}.`
    );
  }

  if (p.includes('center') || p.includes('recenter') || p.includes('lock') || p.includes('track')) {
    ops.push({
      type: 'center_subject',
      offsetX: 0,
      smoothing: 0.88,
      summary: 'Re-Center Subject Lock',
    });
    replies.push(
      `Recalibrated the 9:16 tracking solver to lock onto the primary subject centroid.`
    );
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

  if (p.includes('zoom') || p.includes('punch') || p.includes('closer') || p.includes('wide')) {
    const zoom = p.includes('wide') || p.includes('out') ? 1.0 : numVal && numVal < 2.5 ? numVal : 1.24;
    ops.push({
      type: 'set_zoom',
      zoom,
      summary: `Zoom ${zoom.toFixed(2)}x`,
    });
    replies.push(`Set dynamic punch-in scale on "${body.activeClip.name}" to ${zoom.toFixed(2)}x.`);
  }

  if (p.includes('faster') || p.includes('slower') || p.includes('pace') || p.includes('pacing') || p.includes('beat')) {
    const mult = p.includes('slower') ? 1.35 : 0.72;
    ops.push({
      type: 'repace_cuts',
      pacingMultiplier: mult,
      summary: mult < 1 ? 'Pacing +28% Faster' : 'Pacing -35% Slower',
    });
    replies.push(
      `Re-computed internal sub-cuts on "${body.activeClip.name}" (${mult < 1 ? 'faster hook cadence' : 'longer takes'}).`
    );
  }

  if (p.includes('caption') || p.includes('subtitle') || p.includes('text') || p.includes('hook')) {
    const quoted = body.userPrompt.match(/["']([^"']+)["']/);
    const newText = quoted ? quoted[1] : body.activeClip.captionText.toUpperCase() + ' 🔥';
    ops.push({
      type: 'update_caption',
      captionText: newText,
      summary: `Caption: "${newText.slice(0, 18)}..."`,
    });
    replies.push(`Updated social caption overlay to "${newText}".`);
  }

  if (p.includes('save') && p.includes('scheme')) {
    const quoted = body.userPrompt.match(/["']([^"']+)["']/);
    const presetName = quoted ? quoted[1] : `Iterated ${body.schemeName}`;
    ops.push({
      type: 'save_scheme_preset',
      schemePresetName: presetName,
      summary: `Saved Scheme "${presetName}"`,
    });
    replies.push(`Saved current cut pacing, zoom, and tracking parameters as a new scheme: "${presetName}".`);
  }

  if (ops.length === 0) {
    if (body.activeClip.id === '__full_source__') {
      ops.push({
        type: 'generate_edited_clips',
        clipsCount: parsedCount,
        targetDuration: parsedDuration,
        clipMode: 'condensed-edit',
        summary: 'Generated Edited Clips from Full Video',
      });
      replies.push(
        `Created edited 9:16 highlight clips from your full video and loaded the first edit onto the timeline.`
      );
    } else {
      ops.push(
        {
          type: 'center_subject',
          offsetX: 0,
          smoothing: 0.86,
          summary: 'Refined Subject Lock',
        },
        {
          type: 'set_zoom',
          zoom: 1.15,
          summary: 'Punch-In 1.15x',
        }
      );
      replies.push(
        `Tightened subject centering on "${body.activeClip.name}" and added a 1.15x emphasis zoom at ${body.currentPlayhead.toFixed(1)}s.`
      );
    }
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
