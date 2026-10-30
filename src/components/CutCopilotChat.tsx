import React, { useState } from 'react';
import {
  Bot,
  CornerDownLeft,
  History,
  MessageSquarePlus,
  RotateCcw,
  Sparkles,
  Wand2,
} from 'lucide-react';
import {
  AIProviderSettings,
  CopilotChatMessage,
  GeneratedClip,
} from '../types/editor';
import { formatSMPTETimecode } from '../services/clipGenerator';

interface CutCopilotChatProps {
  messages: CopilotChatMessage[];
  activeClip: GeneratedClip | null;
  playheadTime: number;
  aiSettings: AIProviderSettings;
  isSending: boolean;
  onSendMessage: (prompt: string) => void;
  onRevertSnapshot: (snapshotId: string) => void;
  onOpenAISettings: () => void;
}

const QUICK_PROMPTS = [
  'Start this cut 1.5s earlier',
  'Make cuts 28% faster for TikTok',
  'Center subject & increase smoothing to 90%',
  'Add 1.25x punch-in zoom on this cut',
  'Split clip at playhead',
  'Save current edits as a new Scheme',
];

export const CutCopilotChat: React.FC<CutCopilotChatProps> = ({
  messages,
  activeClip,
  playheadTime,
  aiSettings,
  isSending,
  onSendMessage,
  onRevertSnapshot,
  onOpenAISettings,
}) => {
  const [input, setInput] = useState('');

  const activeCut = activeClip?.subCuts.find(
    (c) => playheadTime >= c.sourceStart && playheadTime <= c.sourceEnd
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isSending) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const providerLabel =
    aiSettings.activeProvider === 'gemini'
      ? 'Gemini'
      : aiSettings.activeProvider === 'claude'
        ? 'Claude'
        : 'OpenAI';

  return (
    <div
      style={{
        width: 315,
        flexShrink: 0,
        borderLeft: '1px solid #151515',
        background: '#1c1c1c',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {/* Copilot Context Header */}
      <div
        style={{
          padding: '6px 10px',
          background: '#171717',
          borderBottom: '1px solid #282828',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
            <Bot size={13} color="#46a3ff" />
            <span>Cut Copilot — Iterative Feedback</span>
          </div>
          <button
            onClick={onOpenAISettings}
            style={{
              background: 'rgba(45, 140, 235, 0.16)',
              border: '1px solid rgba(45, 140, 235, 0.4)',
              borderRadius: 3,
              padding: '1px 6px',
              fontSize: 10,
              color: '#46a3ff',
              cursor: 'pointer',
            }}
            title="Click to switch between Gemini (default), Claude, and OpenAI"
          >
            {providerLabel} • {aiSettings.models[aiSettings.activeProvider]}
          </button>
        </div>

        {/* Active Cut / Timecode Target Chip */}
        {activeClip && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              fontSize: 10,
              color: '#9e9e9e',
              background: '#222',
              padding: '3px 6px',
              borderRadius: 3,
            }}
          >
            <span style={{ color: '#dcdcdc', fontWeight: 500 }}>
              Target: {activeClip.name.slice(0, 18)}
            </span>
            <span className="pr-timecode" style={{ fontSize: 10 }}>
              {activeCut ? `Cut #${activeCut.index}` : 'Clip'} @ {formatSMPTETimecode(playheadTime)}
            </span>
          </div>
        )}
      </div>

      {/* Messages Thread */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
              maxWidth: '94%',
              background: msg.role === 'user' ? '#2d5b88' : '#252525',
              border: msg.role === 'user' ? '1px solid #3e7ab3' : '1px solid #333333',
              borderRadius: 4,
              padding: '7px 9px',
              fontSize: 11,
              lineHeight: 1.4,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                fontSize: 9.5,
                color: msg.role === 'user' ? '#b8dcff' : '#8a8a8a',
                marginBottom: 3,
                gap: 6,
              }}
            >
              <span>
                {msg.role === 'user' ? 'Editor Feedback' : `Cut Copilot (${msg.providerBadge || providerLabel})`}
              </span>
              {msg.playheadTime !== undefined && (
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  @{formatSMPTETimecode(msg.playheadTime)}
                </span>
              )}
            </div>

            <div style={{ color: '#ececec' }}>{msg.content}</div>

            {/* Applied Operation Badges + Undo Button */}
            {msg.operationBadges && msg.operationBadges.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 4,
                  marginTop: 6,
                  alignItems: 'center',
                }}
              >
                {msg.operationBadges.map((b, i) => (
                  <span
                    key={i}
                    style={{
                      fontSize: 9.5,
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: 'rgba(45, 140, 235, 0.22)',
                      border: '1px solid rgba(45, 140, 235, 0.5)',
                      color: '#7cc0ff',
                      fontWeight: 500,
                    }}
                  >
                    ✓ {b}
                  </span>
                ))}

                {msg.revisionSnapshotId && (
                  <button
                    onClick={() => onRevertSnapshot(msg.revisionSnapshotId!)}
                    style={{
                      marginLeft: 'auto',
                      background: '#303030',
                      border: '1px solid #484848',
                      borderRadius: 3,
                      padding: '1px 6px',
                      fontSize: 9.5,
                      color: '#fca5a5',
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                    }}
                    title="Undo this AI edit and restore previous cut state"
                  >
                    <RotateCcw size={9} />
                    Undo
                  </button>
                )}
              </div>
            )}
          </div>
        ))}

        {isSending && (
          <div
            style={{
              padding: '6px 9px',
              background: '#252525',
              borderRadius: 4,
              fontSize: 11,
              color: '#46a3ff',
            }}
          >
            Applying cut feedback via {providerLabel}...
          </div>
        )}
      </div>

      {/* Quick Iteration Prompt Pills */}
      <div
        style={{
          padding: '5px 8px',
          borderTop: '1px solid #252525',
          display: 'flex',
          gap: 4,
          overflowX: 'auto',
          background: '#181818',
        }}
      >
        {QUICK_PROMPTS.map((qp) => (
          <button
            key={qp}
            onClick={() => onSendMessage(qp)}
            disabled={isSending}
            style={{
              whiteSpace: 'nowrap',
              fontSize: 10,
              padding: '2px 7px',
              borderRadius: 3,
              background: '#262626',
              border: '1px solid #363636',
              color: '#c4c4c4',
              cursor: 'pointer',
            }}
          >
            {qp}
          </button>
        ))}
      </div>

      {/* Chat Input Form */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: 'flex',
          gap: 5,
          padding: 7,
          background: '#161616',
          borderTop: '1px solid #262626',
        }}
      >
        <input
          type="text"
          className="pr-input"
          style={{ flex: 1 }}
          placeholder="Give feedback on this cut (e.g. 'Start 2s earlier, punch in 1.2x')..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="submit"
          className="pr-btn pr-btn-primary"
          disabled={isSending || !input.trim()}
          style={{ padding: '4px 8px' }}
        >
          <CornerDownLeft size={12} />
        </button>
      </form>
    </div>
  );
};
