// Vercel Serverless Function: /api/auth
// Enforces @complex.com email domain authentication for ClipMaker Studio.

import crypto from 'crypto';

export interface ComplexAuthUser {
  email: string;
  name: string;
  domain: string;
  signedInAt: string;
  token: string;
}

const ALLOWED_DOMAIN = 'complex.com';

function getSigningSecret(): string {
  return (
    process.env.COMPLEX_AUTH_SECRET ||
    process.env.GEMINI_API_KEY ||
    'clipmaker-complex-studio-internal-secret-2026'
  );
}

export function isValidComplexEmail(rawEmail: string): boolean {
  if (!rawEmail || typeof rawEmail !== 'string') return false;
  const cleaned = rawEmail.trim().toLowerCase();
  const parts = cleaned.split('@');
  if (parts.length !== 2) return false;
  const [localPart, domain] = parts;
  if (!localPart || localPart.length < 1) return false;
  if (!/^[a-z0-9._+-]+$/.test(localPart)) return false;
  return domain === ALLOWED_DOMAIN;
}

export function createComplexSessionToken(email: string, name: string): ComplexAuthUser {
  const normalizedEmail = email.trim().toLowerCase();
  const displayName =
    name.trim() ||
    normalizedEmail
      .split('@')[0]
      .replace(/[._-]+/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const signedInAt = new Date().toISOString();
  const payload = JSON.stringify({
    email: normalizedEmail,
    name: displayName,
    domain: ALLOWED_DOMAIN,
    signedInAt,
  });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', getSigningSecret())
    .update(payloadB64)
    .digest('base64url');
  return {
    email: normalizedEmail,
    name: displayName,
    domain: ALLOWED_DOMAIN,
    signedInAt,
    token: `${payloadB64}.${sig}`,
  };
}

export function verifyComplexSessionToken(token?: string): ComplexAuthUser | null {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  try {
    const [payloadB64, sig] = token.split('.');
    const expectedSig = crypto
      .createHmac('sha256', getSigningSecret())
      .update(payloadB64)
      .digest('base64url');
    if (sig !== expectedSig) return null;
    const decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!isValidComplexEmail(decoded.email)) return null;
    return {
      email: decoded.email,
      name: decoded.name || decoded.email.split('@')[0],
      domain: ALLOWED_DOMAIN,
      signedInAt: decoded.signedInAt,
      token,
    };
  } catch {
    return null;
  }
}

export function handleAuthRequest(body: {
  action?: 'login' | 'verify';
  email?: string;
  name?: string;
  accessCode?: string;
  token?: string;
}): { ok: boolean; user?: ComplexAuthUser; error?: string } {
  if (body.action === 'verify') {
    const verified = verifyComplexSessionToken(body.token);
    if (!verified) {
      return { ok: false, error: 'Session expired or invalid. Please sign in with your @complex.com email.' };
    }
    return { ok: true, user: verified };
  }

  const email = (body.email || '').trim().toLowerCase();
  if (!email) {
    return { ok: false, error: 'Please enter your @complex.com email address.' };
  }
  if (!isValidComplexEmail(email)) {
    return {
      ok: false,
      error: 'Access Denied: Only @complex.com email addresses are authorized to use ClipMaker Studio.',
    };
  }

  const requiredCode = (process.env.COMPLEX_ACCESS_CODE || '').trim();
  if (requiredCode && (body.accessCode || '').trim() !== requiredCode) {
    return {
      ok: false,
      error: 'Invalid Complex Studio team access code.',
    };
  }

  const user = createComplexSessionToken(email, body.name || '');
  return { ok: true, user };
}

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const result = handleAuthRequest(body);
    res.statusCode = result.ok ? 200 : 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'Authentication error' }));
  }
}
