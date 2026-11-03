import React, { useEffect, useRef, useState } from 'react';
import { KeyRound, Scissors, ShieldCheck, Sparkles } from 'lucide-react';
import {
  ComplexAuthUser,
  verifyGoogleAccessTokenWithServer,
  verifyGoogleIdTokenWithServer,
} from '../services/projectStorage';

interface ComplexAuthGateProps {
  serverAIStatus?: {
    geminiConfigured: boolean;
    claudeConfigured: boolean;
    openaiConfigured: boolean;
    googleClientId?: string;
  };
  onAuthenticated: (user: ComplexAuthUser) => void;
}

const LOCAL_GCLIENT_KEY = 'clipmaker_google_oauth_client_id_v1';

export const ComplexAuthGate: React.FC<ComplexAuthGateProps> = ({
  serverAIStatus,
  onAuthenticated,
}) => {
  const envClientId =
    ((import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '').trim() ||
    (serverAIStatus?.googleClientId || '').trim();

  const [customClientId, setCustomClientId] = useState<string>(
    () => localStorage.getItem(LOCAL_GCLIENT_KEY) || ''
  );
  const [showClientIdSetup, setShowClientIdSetup] = useState<boolean>(false);
  const [gsiReady, setGsiReady] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const googleButtonContainerRef = useRef<HTMLDivElement | null>(null);

  const activeClientId = envClientId || customClientId.trim();

  // Load Google Identity Services script (https://accounts.google.com/gsi/client)
  useEffect(() => {
    const existing = document.querySelector(
      'script[src="https://accounts.google.com/gsi/client"]'
    ) as HTMLScriptElement | null;

    if ((window as any).google?.accounts) {
      setGsiReady(true);
      return;
    }

    if (existing) {
      const onLoad = () => setGsiReady(true);
      existing.addEventListener('load', onLoad);
      return () => existing.removeEventListener('load', onLoad);
    }

    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => setGsiReady(true);
    script.onerror = () =>
      setError('Could not load Google Sign-In SDK. Check your network connection.');
    document.head.appendChild(script);
  }, []);

  // Initialize Google Identity Services button with hosted_domain: 'complex.com'
  useEffect(() => {
    if (!gsiReady || !activeClientId || !googleButtonContainerRef.current) return;
    const g = (window as any).google;
    if (!g?.accounts?.id) return;

    try {
      g.accounts.id.initialize({
        client_id: activeClientId,
        hosted_domain: 'complex.com',
        ux_mode: 'popup',
        callback: async (response: { credential?: string }) => {
          if (!response?.credential) return;
          setError(null);
          setIsLoading(true);
          try {
            const res = await verifyGoogleIdTokenWithServer(
              response.credential,
              activeClientId
            );
            if (!res.ok || !res.user) {
              setError(
                res.error ||
                  'Access Denied: You must sign in with a @complex.com Google Workspace account.'
              );
            } else {
              onAuthenticated(res.user);
            }
          } finally {
            setIsLoading(false);
          }
        },
      });

      googleButtonContainerRef.current.innerHTML = '';
      g.accounts.id.renderButton(googleButtonContainerRef.current, {
        theme: 'filled_blue',
        size: 'large',
        type: 'standard',
        shape: 'rectangular',
        text: 'signin_with',
        width: 360,
      });
    } catch (e: any) {
      console.warn('Google button render warning:', e);
    }
  }, [gsiReady, activeClientId, onAuthenticated]);

  // Trigger Google OAuth2 Popup with hd: 'complex.com'
  const handleGooglePopupSignIn = () => {
    setError(null);
    if (!activeClientId) {
      setShowClientIdSetup(true);
      setError(
        'Google OAuth Client ID is required. Set GOOGLE_CLIENT_ID in Vercel Environment Variables (or .env) or paste it below.'
      );
      return;
    }

    const g = (window as any).google;
    if (!g?.accounts?.oauth2) {
      setError('Google OAuth SDK is still loading. Please try again in a moment.');
      return;
    }

    try {
      const tokenClient = g.accounts.oauth2.initTokenClient({
        client_id: activeClientId,
        scope: 'openid email profile',
        hd: 'complex.com',
        prompt: 'select_account',
        callback: async (tokenResponse: { access_token?: string; error?: string }) => {
          if (tokenResponse?.error || !tokenResponse?.access_token) {
            if (tokenResponse?.error && tokenResponse.error !== 'popup_closed_by_user') {
              setError(`Google Sign-In error: ${tokenResponse.error}`);
            }
            return;
          }
          setIsLoading(true);
          try {
            const res = await verifyGoogleAccessTokenWithServer(tokenResponse.access_token);
            if (!res.ok || !res.user) {
              setError(
                res.error ||
                  'Access Denied: Only @complex.com Google Workspace accounts are permitted.'
              );
            } else {
              onAuthenticated(res.user);
            }
          } finally {
            setIsLoading(false);
          }
        },
      });
      tokenClient.requestAccessToken();
    } catch (e: any) {
      setError(e?.message || 'Failed to launch Google Sign-In popup.');
    }
  };

  return (
    <div
      style={{
        minHeight: '100vh',
        width: '100vw',
        background: 'radial-gradient(circle at 50% 18%, #1e293b 0%, #090b10 70%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        fontFamily: 'var(--font-ui, Inter, sans-serif)',
        color: '#f8fafc',
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: 'rgba(17, 20, 28, 0.96)',
          border: '1px solid rgba(96, 165, 250, 0.35)',
          borderRadius: 12,
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.85)',
          overflow: 'hidden',
        }}
      >
        {/* Top Banner */}
        <div
          style={{
            padding: '22px 24px 18px',
            background:
              'linear-gradient(180deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0) 100%)',
            borderBottom: '1px solid rgba(51, 65, 85, 0.6)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 9,
              background: 'rgba(45, 140, 235, 0.18)',
              border: '1px solid rgba(96, 165, 250, 0.45)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Scissors size={20} color="#60a5fa" />
          </div>
          <div>
            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '-0.3px' }}>
              ClipMaker Studio
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
              Complex Networks Internal 9:16 Video Suite
            </div>
          </div>
        </div>

        {/* Body */}
        <div
          style={{
            padding: '22px 24px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
          }}
        >
          <div
            style={{
              padding: '11px 13px',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.32)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              fontSize: 12,
              color: '#a7f3d0',
              lineHeight: 1.45,
            }}
          >
            <ShieldCheck size={18} color="#34d399" style={{ flexShrink: 0 }} />
            <span>
              <strong>Google Workspace SSO Required:</strong> Sign in with your verified{' '}
              <strong>@complex.com</strong> Google account to access ClipMaker Studio.
            </span>
          </div>

          {/* Official Google Identity Services Button Container (when Client ID is present) */}
          {activeClientId && (
            <div
              ref={googleButtonContainerRef}
              style={{
                display: 'flex',
                justifyContent: 'center',
                minHeight: 44,
              }}
            />
          )}

          {/* Direct Google OAuth Popup Button (enforces hd=complex.com) */}
          <button
            type="button"
            onClick={handleGooglePopupSignIn}
            disabled={isLoading}
            style={{
              width: '100%',
              padding: '11px 16px',
              borderRadius: 7,
              border: '1px solid #475569',
              background: '#ffffff',
              color: '#0f172a',
              fontSize: 13.5,
              fontWeight: 700,
              cursor: isLoading ? 'wait' : 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              boxShadow: '0 4px 14px rgba(0, 0, 0, 0.35)',
              transition: 'all 0.15s',
            }}
          >
            {/* Official Google G Logo SVG */}
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path
                fill="#EA4335"
                d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
              />
              <path
                fill="#4285F4"
                d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
              />
              <path
                fill="#FBBC05"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#34A853"
                d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
              />
            </svg>
            <span>
              {isLoading
                ? 'Verifying @complex.com Google Account...'
                : 'Sign in with Google (@complex.com)'}
            </span>
          </button>

          {error && (
            <div
              style={{
                padding: '10px 12px',
                background: 'rgba(239, 68, 68, 0.14)',
                border: '1px solid rgba(248, 113, 113, 0.45)',
                borderRadius: 6,
                color: '#fca5a5',
                fontSize: 12,
                fontWeight: 500,
                lineHeight: 1.4,
              }}
            >
              {error}
            </div>
          )}

          {/* Setup box if GOOGLE_CLIENT_ID is not yet configured in Vercel / .env */}
          {(!envClientId || showClientIdSetup) && (
            <div
              style={{
                padding: 12,
                borderRadius: 8,
                background: 'rgba(15, 23, 42, 0.75)',
                border: '1px solid #334155',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: '#93c5fd',
                }}
              >
                <KeyRound size={13} />
                <span>Google OAuth Client ID Setup (`GOOGLE_CLIENT_ID`)</span>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', lineHeight: 1.4 }}>
                Add <code>GOOGLE_CLIENT_ID</code> in Vercel Environment Variables (or{' '}
                <code>.env</code>), or paste your Google OAuth 2.0 Web Client ID below:
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  placeholder="xxxx-xxxx.apps.googleusercontent.com"
                  value={customClientId}
                  onChange={(e) => {
                    const val = e.target.value;
                    setCustomClientId(val);
                    localStorage.setItem(LOCAL_GCLIENT_KEY, val.trim());
                    if (error) setError(null);
                  }}
                  style={{
                    flex: 1,
                    padding: '7px 10px',
                    borderRadius: 5,
                    border: '1px solid #475569',
                    background: '#090b10',
                    color: '#fff',
                    fontSize: 11.5,
                    fontFamily: 'var(--font-mono, monospace)',
                  }}
                />
              </div>
            </div>
          )}

          {/* Shared Environment AI Keys Status Footer */}
          {serverAIStatus && (
            <div
              style={{
                marginTop: 2,
                paddingTop: 12,
                borderTop: '1px solid rgba(51, 65, 85, 0.5)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 11,
                color: '#94a3b8',
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <Sparkles size={12} color="#60a5fa" />
                Shared Env AI Keys:
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <span
                  style={{
                    color: serverAIStatus.geminiConfigured ? '#34d399' : '#64748b',
                    fontWeight: 600,
                  }}
                >
                  ● Gemini
                </span>
                <span
                  style={{
                    color: serverAIStatus.claudeConfigured ? '#34d399' : '#64748b',
                    fontWeight: 600,
                  }}
                >
                  ● Claude
                </span>
                <span
                  style={{
                    color: serverAIStatus.openaiConfigured ? '#34d399' : '#64748b',
                    fontWeight: 600,
                  }}
                >
                  ● OpenAI
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
