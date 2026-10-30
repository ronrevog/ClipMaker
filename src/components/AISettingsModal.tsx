import React, { useState } from 'react';
import { Check, Cpu, KeyRound, Server, X } from 'lucide-react';
import { AIProviderId, AIProviderSettings } from '../types/editor';

interface AISettingsModalProps {
  isOpen: boolean;
  settings: AIProviderSettings;
  onClose: () => void;
  onSave: (updated: AIProviderSettings) => void;
}

export const AISettingsModal: React.FC<AISettingsModalProps> = ({
  isOpen,
  settings,
  onClose,
  onSave,
}) => {
  const [draft, setDraft] = useState<AIProviderSettings>(settings);

  if (!isOpen) return null;

  const updateModel = (provider: AIProviderId, model: string) => {
    setDraft((prev) => ({
      ...prev,
      models: { ...prev.models, [provider]: model },
    }));
  };

  const updateKey = (provider: AIProviderId, key: string) => {
    setDraft((prev) => ({
      ...prev,
      apiKeys: { ...prev.apiKeys, [provider]: key },
    }));
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.72)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <div
        style={{
          width: 540,
          background: '#232323',
          border: '1px solid #2d8ceb',
          borderRadius: 4,
          boxShadow: '0 20px 50px rgba(0,0,0,0.8)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            background: '#1b1b1b',
            borderBottom: '1px solid #121212',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600 }}>
            <Cpu size={15} color="#46a3ff" />
            <span>AI Engine & Vercel Provider Configuration</span>
          </div>
          <button className="pr-icon-btn" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div
            style={{
              padding: '9px 12px',
              background: 'rgba(45, 140, 235, 0.12)',
              border: '1px solid rgba(45, 140, 235, 0.35)',
              borderRadius: 4,
              fontSize: 11.5,
              lineHeight: 1.45,
              color: '#d4e8ff',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            }}
          >
            <Server size={16} color="#46a3ff" style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>Vercel Infrastructure Mode:</strong> Serverless routes (
              <code>/api/ai-copilot</code> &amp; <code>/api/ai-style-clone</code>) automatically read{' '}
              <code>GEMINI_API_KEY</code> (default), <code>ANTHROPIC_API_KEY</code>, and{' '}
              <code>OPENAI_API_KEY</code> from your Vercel environment. You can also enter optional
              override keys below.
            </div>
          </div>

          {/* Default Provider Selection */}
          <div>
            <label style={{ display: 'block', marginBottom: 6, color: '#b5b5b5', fontWeight: 500 }}>
              Active AI Provider (Used for Reference Video Style Cloning &amp; Cut Copilot Chat)
            </label>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {(
                [
                  {
                    id: 'gemini',
                    title: 'Google Gemini (Default)',
                    sub: 'Native Multimodal Vision & Fast Cut JSON',
                  },
                  {
                    id: 'claude',
                    title: 'Anthropic Claude',
                    sub: 'Nuanced Editorial Pacing & Cut Logic',
                  },
                  {
                    id: 'openai',
                    title: 'OpenAI GPT-4o',
                    sub: 'Omni Vision & Structured Cut Tooling',
                  },
                ] as const
              ).map((item) => {
                const selected = draft.activeProvider === item.id;
                return (
                  <div
                    key={item.id}
                    onClick={() => setDraft({ ...draft, activeProvider: item.id })}
                    style={{
                      padding: 10,
                      borderRadius: 4,
                      border: selected ? '1px solid #2d8ceb' : '1px solid #383838',
                      background: selected ? 'rgba(45, 140, 235, 0.16)' : '#1a1a1a',
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        fontWeight: 600,
                        color: selected ? '#46a3ff' : '#e0e0e0',
                        marginBottom: 3,
                      }}
                    >
                      {item.title}
                    </div>
                    <div style={{ fontSize: 10.5, color: '#8f8f8f' }}>{item.sub}</div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Provider Models & Optional Override Keys */}
          {(
            [
              {
                id: 'gemini' as AIProviderId,
                name: 'Google Gemini',
                envVar: 'GEMINI_API_KEY',
                models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
              },
              {
                id: 'claude' as AIProviderId,
                name: 'Anthropic Claude',
                envVar: 'ANTHROPIC_API_KEY',
                models: [
                  'claude-3-7-sonnet-latest',
                  'claude-sonnet-4-20250514',
                  'claude-3-5-haiku-latest',
                ],
              },
              {
                id: 'openai' as AIProviderId,
                name: 'OpenAI',
                envVar: 'OPENAI_API_KEY',
                models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'],
              },
            ]
          ).map((prov) => (
            <div
              key={prov.id}
              style={{
                padding: 10,
                background: '#1b1b1b',
                border: '1px solid #2e2e2e',
                borderRadius: 4,
                display: 'grid',
                gridTemplateColumns: '150px 1fr',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, color: '#dcdcdc' }}>{prov.name}</div>
                <div style={{ fontSize: 10, color: '#7a7a7a', fontFamily: 'var(--font-mono)' }}>
                  env: {prov.envVar}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <select
                  className="pr-select"
                  value={draft.models[prov.id]}
                  onChange={(e) => updateModel(prov.id, e.target.value)}
                  style={{ width: 175 }}
                >
                  {prov.models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <div style={{ position: 'relative', flex: 1 }}>
                  <KeyRound
                    size={11}
                    color="#777"
                    style={{ position: 'absolute', left: 7, top: 7 }}
                  />
                  <input
                    type="password"
                    className="pr-input"
                    style={{ width: '100%', paddingLeft: 24 }}
                    placeholder={`Uses Vercel ${prov.envVar} (or paste override)`}
                    value={draft.apiKeys[prov.id]}
                    onChange={(e) => updateKey(prov.id, e.target.value)}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '10px 16px',
            background: '#1b1b1b',
            borderTop: '1px solid #141414',
          }}
        >
          <button className="pr-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="pr-btn pr-btn-primary"
            onClick={() => {
              onSave(draft);
              onClose();
            }}
          >
            <Check size={12} />
            Save AI Settings
          </button>
        </div>
      </div>
    </div>
  );
};
