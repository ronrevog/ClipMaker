import React, { useState } from 'react';
import { Lock, Mail, Scissors, ShieldCheck, Sparkles, User } from 'lucide-react';
import {
  ComplexAuthUser,
  isComplexDomainEmail,
  signInWithComplexEmail,
} from '../services/projectStorage';

interface ComplexAuthGateProps {
  accessCodeRequired?: boolean;
  serverAIStatus?: {
    geminiConfigured: boolean;
    claudeConfigured: boolean;
    openaiConfigured: boolean;
  };
  onAuthenticated: (user: ComplexAuthUser) => void;
}

export const ComplexAuthGate: React.FC<ComplexAuthGateProps> = ({
  accessCodeRequired = false,
  serverAIStatus,
  onAuthenticated,
}) => {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanedEmail = email.trim().toLowerCase();
    if (!cleanedEmail) {
      setError('Please enter your @complex.com email address.');
      return;
    }
    if (!isComplexDomainEmail(cleanedEmail)) {
      setError('Access Denied: Only @complex.com email addresses are allowed.');
      return;
    }

    setIsLoading(true);
    try {
      const res = await signInWithComplexEmail(cleanedEmail, name, accessCode);
      if (!res.ok || !res.user) {
        setError(res.error || 'Could not authenticate. Please verify your @complex.com email.');
      } else {
        onAuthenticated(res.user);
      }
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
            background: 'linear-gradient(180deg, rgba(30, 41, 59, 0.7) 0%, rgba(15, 23, 42, 0) 100%)',
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

        {/* Form Body */}
        <form
          onSubmit={handleSubmit}
          style={{ padding: '20px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div
            style={{
              padding: '10px 12px',
              background: 'rgba(16, 185, 129, 0.1)',
              border: '1px solid rgba(16, 185, 129, 0.32)',
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 9,
              fontSize: 12,
              color: '#a7f3d0',
            }}
          >
            <ShieldCheck size={16} color="#34d399" style={{ flexShrink: 0 }} />
            <span>
              Restricted to <strong>@complex.com</strong> team accounts. Shared AI keys &amp; cloud
              project persistence are enabled automatically.
            </span>
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: '#cbd5e1',
                marginBottom: 6,
              }}
            >
              Complex Work Email (@complex.com) *
            </label>
            <div style={{ position: 'relative' }}>
              <Mail
                size={15}
                color="#64748b"
                style={{
                  position: 'absolute',
                  left: 11,
                  top: '50%',
                  transform: 'translateY(-50%)',
                }}
              />
              <input
                type="email"
                required
                autoFocus
                placeholder="firstname.lastname@complex.com"
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (error) setError(null);
                }}
                style={{
                  width: '100%',
                  padding: '9px 12px 9px 34px',
                  borderRadius: 6,
                  border: '1px solid #334155',
                  background: '#0f131a',
                  color: '#fff',
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          <div>
            <label
              style={{
                display: 'block',
                fontSize: 12,
                fontWeight: 600,
                color: '#cbd5e1',
                marginBottom: 6,
              }}
            >
              Editor Name (Optional — shown on saved projects)
            </label>
            <div style={{ position: 'relative' }}>
              <User
                size={15}
                color="#64748b"
                style={{
                  position: 'absolute',
                  left: 11,
                  top: '50%',
                  transform: 'translateY(-50%)',
                }}
              />
              <input
                type="text"
                placeholder="e.g. Alex Rivera"
                value={name}
                onChange={(e) => setName(e.target.value)}
                style={{
                  width: '100%',
                  padding: '9px 12px 9px 34px',
                  borderRadius: 6,
                  border: '1px solid #334155',
                  background: '#0f131a',
                  color: '#fff',
                  fontSize: 13,
                  outline: 'none',
                  boxSizing: 'border-box',
                }}
              />
            </div>
          </div>

          {accessCodeRequired && (
            <div>
              <label
                style={{
                  display: 'block',
                  fontSize: 12,
                  fontWeight: 600,
                  color: '#cbd5e1',
                  marginBottom: 6,
                }}
              >
                Team Access Code *
              </label>
              <div style={{ position: 'relative' }}>
                <Lock
                  size={15}
                  color="#64748b"
                  style={{
                    position: 'absolute',
                    left: 11,
                    top: '50%',
                    transform: 'translateY(-50%)',
                  }}
                />
                <input
                  type="password"
                  required
                  placeholder="Enter team access code"
                  value={accessCode}
                  onChange={(e) => setAccessCode(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '9px 12px 9px 34px',
                    borderRadius: 6,
                    border: '1px solid #334155',
                    background: '#0f131a',
                    color: '#fff',
                    fontSize: 13,
                    outline: 'none',
                    boxSizing: 'border-box',
                  }}
                />
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '9px 11px',
                background: 'rgba(239, 68, 68, 0.14)',
                border: '1px solid rgba(248, 113, 113, 0.45)',
                borderRadius: 6,
                color: '#fca5a5',
                fontSize: 12,
                fontWeight: 500,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={isLoading}
            className="btn btn-primary"
            style={{
              width: '100%',
              padding: '10px 14px',
              fontSize: 13,
              fontWeight: 700,
              justifyContent: 'center',
              marginTop: 4,
            }}
          >
            {isLoading ? 'Verifying @complex.com Account...' : 'Sign In to ClipMaker Studio →'}
          </button>

          {/* Shared Environment AI Keys Status Footer */}
          {serverAIStatus && (
            <div
              style={{
                marginTop: 4,
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
        </form>
      </div>
    </div>
  );
};
