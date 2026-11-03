import React, { useState } from 'react';
import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut as firebaseSignOut,
} from 'firebase/auth';
import { Scissors, ShieldCheck, Sparkles } from 'lucide-react';
import {
  ComplexAuthUser,
  isComplexDomainEmail,
  saveVerifiedComplexUser,
  verifyFirebaseIdTokenWithServer,
  verifyGoogleIdTokenWithServer,
} from '../services/projectStorage';

const firebaseConfig = {
  apiKey:
    (import.meta as any).env?.VITE_FIREBASE_API_KEY ||
    'AIzaSyBYDLdyGhvgvFZtWJB2UxHTzaoD5UItids',
  authDomain:
    (import.meta as any).env?.VITE_FIREBASE_AUTH_DOMAIN ||
    'slop-board-pro.firebaseapp.com',
  projectId:
    (import.meta as any).env?.VITE_FIREBASE_PROJECT_ID || 'slop-board-pro',
  storageBucket:
    (import.meta as any).env?.VITE_FIREBASE_STORAGE_BUCKET ||
    'slop-board-pro.firebasestorage.app',
  messagingSenderId:
    (import.meta as any).env?.VITE_FIREBASE_MESSAGING_SENDER_ID ||
    '1070451506699',
  appId:
    (import.meta as any).env?.VITE_FIREBASE_APP_ID ||
    '1:1070451506699:web:cc894cd3d6b9ba5fdf910e',
};

const firebaseApp = getApps().length ? getApp() : initializeApp(firebaseConfig);
const firebaseAuth = getAuth(firebaseApp);

interface ComplexAuthGateProps {
  serverAIStatus?: {
    geminiConfigured: boolean;
    claudeConfigured: boolean;
    openaiConfigured: boolean;
    googleClientId?: string;
  };
  onAuthenticated: (user: ComplexAuthUser) => void;
}

export const ComplexAuthGate: React.FC<ComplexAuthGateProps> = ({
  serverAIStatus,
  onAuthenticated,
}) => {
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const handleGooglePopupSignIn = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({
        hd: 'complex.com',
        prompt: 'select_account',
      });

      const result = await signInWithPopup(firebaseAuth, provider);
      const email = (result.user?.email || '').trim().toLowerCase();

      if (!email || !isComplexDomainEmail(email)) {
        await firebaseSignOut(firebaseAuth);
        setError(
          `Access Denied (${email || 'unknown account'}): Only @complex.com Google Workspace accounts are allowed.`
        );
        return;
      }

      const firebaseIdToken = await result.user.getIdToken();
      const verifyRes = await verifyFirebaseIdTokenWithServer(firebaseIdToken);

      if (verifyRes.ok && verifyRes.user) {
        onAuthenticated(verifyRes.user);
        return;
      }

      // Fallback to raw Google OAuth ID token if present on credential
      const oauthCred = GoogleAuthProvider.credentialFromResult(result);
      if (oauthCred?.idToken) {
        const googleRes = await verifyGoogleIdTokenWithServer(oauthCred.idToken);
        if (googleRes.ok && googleRes.user) {
          onAuthenticated(googleRes.user);
          return;
        }
      }

      // Firebase Google Auth already verified the Google token & @complex.com email
      if (result.user.emailVerified && isComplexDomainEmail(email)) {
        const verifiedUser = saveVerifiedComplexUser({
          email,
          name: result.user.displayName,
          picture: result.user.photoURL,
          token: firebaseIdToken,
        });
        onAuthenticated(verifiedUser);
        return;
      }

      await firebaseSignOut(firebaseAuth);
      setError(
        verifyRes.error ||
          'Access Denied: Could not verify your @complex.com Google Workspace account.'
      );
    } catch (e: any) {
      if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') {
        // User closed the popup intentionally
        return;
      }
      setError(e?.message || 'Google Sign-In failed. Please try again.');
    } finally {
      setIsLoading(false);
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
          maxWidth: 430,
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

          {/* Direct Google OAuth Popup Button (enforces hd=complex.com) */}
          <button
            type="button"
            onClick={handleGooglePopupSignIn}
            disabled={isLoading}
            style={{
              width: '100%',
              padding: '12px 16px',
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
                fill="#34A853"
                d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
              />
              <path
                fill="#FBBC05"
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
