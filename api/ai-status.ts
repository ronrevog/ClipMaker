// Vercel Serverless Function: /api/ai-status
// Resolves shared server-side environment API keys (Gemini, Claude, OpenAI)
// so every @complex.com user automatically gets AI access without entering personal keys.

const PLACEHOLDERS = new Set([
  '',
  'your_gemini_api_key_here',
  'your_anthropic_claude_api_key_here',
  'your_openai_api_key_here',
]);

function cleanEnvKey(val: string | undefined): string {
  if (!val) return '';
  const trimmed = val.trim();
  return PLACEHOLDERS.has(trimmed) ? '' : trimmed;
}

export function getSharedEnvKeyForProvider(provider: 'gemini' | 'claude' | 'openai'): string {
  if (provider === 'gemini') {
    return (
      cleanEnvKey(process.env.GEMINI_API_KEY) ||
      cleanEnvKey(process.env.VITE_GEMINI_API_KEY) ||
      cleanEnvKey(process.env.GOOGLE_API_KEY)
    );
  }
  if (provider === 'claude') {
    return (
      cleanEnvKey(process.env.ANTHROPIC_API_KEY) ||
      cleanEnvKey(process.env.CLAUDE_API_KEY) ||
      cleanEnvKey(process.env.VITE_ANTHROPIC_API_KEY) ||
      cleanEnvKey(process.env.VITE_CLAUDE_API_KEY)
    );
  }
  return (
    cleanEnvKey(process.env.OPENAI_API_KEY) ||
    cleanEnvKey(process.env.VITE_OPENAI_API_KEY)
  );
}

export function resolveProviderApiKey(
  provider: 'gemini' | 'claude' | 'openai',
  apiKeyOverride?: string
): string {
  const override = cleanEnvKey(apiKeyOverride);
  if (override) return override;
  return getSharedEnvKeyForProvider(provider);
}

export function getServerAIStatus() {
  return {
    geminiConfigured: Boolean(getSharedEnvKeyForProvider('gemini')),
    claudeConfigured: Boolean(getSharedEnvKeyForProvider('claude')),
    openaiConfigured: Boolean(getSharedEnvKeyForProvider('openai')),
    blobStorageConfigured: Boolean(
      process.env.BLOB_READ_WRITE_TOKEN && process.env.BLOB_READ_WRITE_TOKEN.trim().length > 10
    ),
    accessCodeRequired: Boolean(
      process.env.COMPLEX_ACCESS_CODE && process.env.COMPLEX_ACCESS_CODE.trim().length > 0
    ),
    allowedDomain: 'complex.com',
  };
}

export default async function handler(_req: any, res: any) {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(getServerAIStatus()));
}
