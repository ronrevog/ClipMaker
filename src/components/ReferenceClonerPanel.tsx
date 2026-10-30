import React, { useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Film,
  Scissors,
  Sparkles,
  Upload,
  Wand2,
  Zap,
} from 'lucide-react';
import { AIProviderSettings, ReferenceVideoAnalysis } from '../types/editor';

interface ReferenceClonerPanelProps {
  referenceAnalyses: ReferenceVideoAnalysis[];
  activeReference: ReferenceVideoAnalysis | null;
  onSelectReference: (ref: ReferenceVideoAnalysis) => void;
  onUploadReferenceFile: (file: File) => void;
  onSynthesizeReferenceScheme: (
    ref: ReferenceVideoAnalysis,
    notes: string,
    applyImmediately: boolean
  ) => Promise<void>;
  aiSettings: AIProviderSettings;
}

export const ReferenceClonerPanel: React.FC<ReferenceClonerPanelProps> = ({
  referenceAnalyses,
  activeReference,
  onSelectReference,
  onUploadReferenceFile,
  onSynthesizeReferenceScheme,
  aiSettings,
}) => {
  const [userNotes, setUserNotes] = useState(
    'Match the rapid hook cut cadence, beat-synced transitions, and punch-in zoom energy.'
  );
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);

  const handleRunClone = async (applyImmediately: boolean) => {
    if (!activeReference) return;
    setIsSynthesizing(true);
    setStatusBanner(null);
    try {
      await onSynthesizeReferenceScheme(activeReference, userNotes, applyImmediately);
      setStatusBanner(
        `Cloned "${activeReference.fileName}" into a saved Editing Scheme (${aiSettings.activeProvider.toUpperCase()})${
          applyImmediately ? ' and re-cut 9:16 timeline!' : '!'
        }`
      );
    } finally {
      setIsSynthesizing(false);
    }
  };

  return (
    <div
      style={{
        flex: 1,
        overflowY: 'auto',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Top Action Row: Upload Reference Video or Choose Reference Sample */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: '#1a1a1a',
          padding: '8px 10px',
          borderRadius: 4,
          border: '1px solid #323232',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Wand2 size={15} color="#a78bfa" />
          <div>
            <div style={{ fontWeight: 600, color: '#e5e5e5' }}>
              Reference Video Style Cloner
            </div>
            <div style={{ fontSize: 10.5, color: '#8f8f8f' }}>
              Upload a reference edit to extract its cut cadence, ASL, beat sync &amp; zoom profile into a Scheme
            </div>
          </div>
        </div>

        <label
          className="pr-btn pr-btn-primary"
          style={{ cursor: 'pointer', background: '#6d4aff', borderColor: '#8b6eff' }}
        >
          <Upload size={12} />
          Upload Reference Video
          <input
            type="file"
            accept="video/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUploadReferenceFile(f);
            }}
          />
        </label>
      </div>

      {/* Reference Selector Pills */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <span style={{ fontSize: 10.5, color: '#888' }}>Loaded Reference Videos:</span>
        {referenceAnalyses.map((ref) => {
          const active = activeReference?.id === ref.id;
          return (
            <button
              key={ref.id}
              onClick={() => onSelectReference(ref)}
              className="pr-btn"
              style={{
                borderColor: active ? '#a78bfa' : '#363636',
                background: active ? 'rgba(139, 92, 246, 0.2)' : '#1e1e1e',
                color: active ? '#e9d5ff' : '#bdbdbd',
                fontSize: 10.5,
                padding: '3px 8px',
              }}
            >
              <Film size={11} />
              {ref.fileName}
            </button>
          );
        })}
      </div>

      {/* Telemetry Breakdown Card */}
      {activeReference && (
        <div
          style={{
            background: '#191919',
            border: '1px solid #2e2e2e',
            borderRadius: 4,
            padding: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, color: '#d8b4fe' }}>
              Extracted Reference Signature: {activeReference.fileName}
            </span>
            <span
              style={{
                fontSize: 10,
                padding: '2px 6px',
                borderRadius: 3,
                background: 'rgba(45, 140, 235, 0.16)',
                color: '#46a3ff',
              }}
            >
              AI Synth Engine: {aiSettings.activeProvider.toUpperCase()} (
              {aiSettings.models[aiSettings.activeProvider]})
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
            <div style={{ background: '#222', padding: 7, borderRadius: 3 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Avg Shot Length</div>
              <div className="pr-timecode" style={{ fontSize: 14 }}>
                {activeReference.telemetry.averageShotLength}s ASL
              </div>
            </div>
            <div style={{ background: '#222', padding: 7, borderRadius: 3 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Cut Density</div>
              <div className="pr-timecode" style={{ fontSize: 14 }}>
                {activeReference.telemetry.cutsPerMinute}/min
              </div>
            </div>
            <div style={{ background: '#222', padding: 7, borderRadius: 3 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Beat-Sync Alignment</div>
              <div className="pr-timecode" style={{ fontSize: 14, color: '#38b261' }}>
                {Math.round(activeReference.telemetry.beatSyncRatio * 100)}%
              </div>
            </div>
            <div style={{ background: '#222', padding: 7, borderRadius: 3 }}>
              <div style={{ fontSize: 10, color: '#888' }}>Punch-In Scale</div>
              <div className="pr-timecode" style={{ fontSize: 14, color: '#facc15' }}>
                {activeReference.telemetry.estimatedZoomIntensity}x
              </div>
            </div>
          </div>

          {/* Visual Cut Cadence Barcode */}
          <div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: 10,
                color: '#888',
                marginBottom: 3,
              }}
            >
              <span>
                <Scissors size={10} style={{ display: 'inline', marginRight: 4 }} />
                Detected Cut Cadence Map ({activeReference.telemetry.detectedCutCount} cuts over{' '}
                {activeReference.telemetry.durationSeconds}s)
              </span>
              <span>
                Motion Energy: {activeReference.telemetry.motionEnergyScore}/100
              </span>
            </div>
            <div
              style={{
                position: 'relative',
                height: 18,
                background: '#121212',
                border: '1px solid #2e2e2e',
                borderRadius: 2,
                overflow: 'hidden',
              }}
            >
              {activeReference.cutTimestamps.map((cutT, i) => (
                <div
                  key={i}
                  style={{
                    position: 'absolute',
                    left: `${(cutT / activeReference.telemetry.durationSeconds) * 100}%`,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: i < 3 ? '#f43f5e' : '#a78bfa',
                  }}
                  title={`Cut #${i + 1} @ ${cutT}s`}
                />
              ))}
            </div>
          </div>

          {/* Style Prompt Notes & Clone Action */}
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="text"
              className="pr-input"
              style={{ flex: 1 }}
              value={userNotes}
              onChange={(e) => setUserNotes(e.target.value)}
              placeholder="Optional instructions for cloning this reference style..."
            />
            <button
              className="pr-btn"
              disabled={isSynthesizing}
              onClick={() => handleRunClone(false)}
            >
              <Sparkles size={12} color="#a78bfa" />
              Save as Scheme
            </button>
            <button
              className="pr-btn pr-btn-primary"
              disabled={isSynthesizing}
              onClick={() => handleRunClone(true)}
            >
              <Zap size={12} />
              {isSynthesizing ? 'Cloning Style...' : 'Clone Style & Auto-Cut 9:16'}
            </button>
          </div>

          {statusBanner && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                borderRadius: 3,
                background: 'rgba(56, 178, 97, 0.16)',
                border: '1px solid rgba(56, 178, 97, 0.45)',
                color: '#86efac',
                fontSize: 11,
              }}
            >
              <CheckCircle2 size={13} />
              <span>{statusBanner}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
