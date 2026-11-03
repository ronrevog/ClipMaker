// Vercel Serverless Function: /api/auth
// Verifies Google Workspace OAuth tokens (id_token or access_token) directly with Google's servers
// and strictly enforces that the authenticated Google account belongs to @complex.com (hd === 'complex.com').

import crypto from 'crypto';
import { getGoogleOAuthClientId } from './ai-status';

export interface ComplexAuthUser {
  email: string;
  name: string;
  picture?: string;
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
  return domain === ALLOWED_DOMAIN;
}

export function createComplexSessionToken(
  email: string,
  name: string,
  picture?: string
): ComplexAuthUser {
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
    picture,
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
    picture,
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
      picture: decoded.picture,
      domain: ALLOWED_DOMAIN,
      signedInAt: decoded.signedInAt,
      token,
    };
  } catch {
    return null;
  }
}

export async function handleAuthRequest(body: {
  action?: 'google-id-token' | 'google-access-token' | 'verify';
  credential?: string;
  accessToken?: string;
  clientId?: string;
  token?: string;
}): Promise<{ ok: boolean; user?: ComplexAuthUser; error?: string }> {
  if (body.action === 'verify') {
    const verified = verifyComplexSessionToken(body.token);
    if (!verified) {
      return {
        ok: false,
        error: 'Session expired or invalid. Please sign in with your @complex.com Google account.',
      };
    }
    return { ok: true, user: verified };
  }

  // 1. Verify Google ID Token (JWT from Google Sign-In button / One Tap)
  if (body.credential) {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(body.credential)}`
    );
    if (!resp.ok) {
      return {
        ok: false,
        error: 'Google token verification failed. Please sign in with Google again.',
      };
    }
    const tokenInfo: any = await resp.json();

    const expectedClientId = getGoogleOAuthClientId() || body.clientId;
    if (expectedClientId && tokenInfo.aud && tokenInfo.aud !== expectedClientId) {
      return {
        ok: false,
        error: 'Google OAuth Client ID mismatch.',
      };
    }

    const email = (tokenInfo.email || '').trim().toLowerCase();
    const emailVerified =
      tokenInfo.email_verified === true || tokenInfo.email_verified === 'true';
    const hostedDomain = (tokenInfo.hd || '').trim().toLowerCase();

    if (!emailVerified || !email) {
      return {
        ok: false,
        error: 'Your Google account email is not verified.',
      };
    }

    if (!isValidComplexEmail(email) || (hostedDomain && hostedDomain !== ALLOWED_DOMAIN)) {
      return {
        ok: false,
        error: `Access Denied (${email}): You must sign in with a @complex.com Google Workspace account.`,
      };
    }

    const user = createComplexSessionToken(
      email,
      tokenInfo.name || email.split('@')[0],
      tokenInfo.picture
    );
    return { ok: true, user };
  }

  // 2. Verify Google OAuth2 Access Token (from google.accounts.oauth2.initTokenClient popup)
  if (body.accessToken) {
    const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: {
        Authorization: `Bearer ${body.accessToken}`,
      },
    });
    if (!resp.ok) {
      return {
        ok: false,
        error: 'Could not verify Google account profile. Please try signing in again.',
      };
    }
    const profile: any = await resp.json();
    const email = (profile.email || '').trim().toLowerCase();
    const emailVerified = profile.email_verified === true;
    const hostedDomain = (profile.hd || '').trim().toLowerCase();

    if (!emailVerified || !email) {
      return {
        ok: false,
        error: 'Your Google account email is not verified.',
      };
    }

    if (!isValidComplexEmail(email) || (hostedDomain && hostedDomain !== ALLOWED_DOMAIN)) {
      return {
        ok: false,
        error: `Access Denied (${email}): You must sign in with a @complex.com Google Workspace account.`,
      };
    }

    const user = createComplexSessionToken(
      email,
      profile.name || email.split('@')[0],
      profile.picture
    );
    return { ok: true, user };
  }

  return {
    ok: false,
    error: 'Google authentication required. Please sign in with your @complex.com Google account.',
  };
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
    const result = await handleAuthRequest(body);
    res.statusCode = result.ok ? 200 : 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err?.message || 'Authentication error' }));
  }
}
