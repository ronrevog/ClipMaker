import React, { useEffect, useState } from 'react';
import {
  Download,
  Film,
  Plus,
  Save,
  Scissors,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { ClipCreationMode, EditingScheme } from '../types/editor';

interface SchemeEditorPanelProps {
  schemes: EditingScheme[];
  activeScheme: EditingScheme;
  onSelectScheme: (scheme: EditingScheme) => void;
  onSaveScheme: (scheme: EditingScheme, applyImmediately?: boolean) => void;
  onDeleteScheme: (schemeId: string) => void;
}

export const SchemeEditorPanel: React.FC<SchemeEditorPanelProps> = ({
  schemes,
  activeScheme,
  onSelectScheme,
  onSaveScheme,
  onDeleteScheme,
}) => {
  const [draft, setDraft] = useState<EditingScheme>(activeScheme);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(activeScheme);
  }, [activeScheme]);

  const handleCreateNewScheme = () => {
    const fresh: EditingScheme = {
      ...activeScheme,
      id: `scheme-custom-${Date.now()}`,
      name: `Custom 9:16 Scheme #${schemes.length + 1}`,
      description: 'Custom social amplification editing scheme with tailored pacing and subject lock.',
      isBuiltIn: false,
      createdAt: new Date().toISOString(),
      clonedFromReference: undefined,
    };
    setDraft(fresh);
    onSaveScheme(fresh, false);
    setSavedNotice('Created new customizable scheme.');
  };

  const handleSave = (applyNow: boolean) => {
    onSaveScheme(draft, applyNow);
    setSavedNotice(
      applyNow
        ? `Saved "${draft.name}" & regenerated 9:16 clips!`
        : `Saved "${draft.name}" to scheme library.`
    );
    setTimeout(() => setSavedNotice(null), 3500);
  };

  const handleExportJson = () => {
    const blob = new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${draft.name.replace(/[^a-z0-9_-]+/gi, '_')}.scheme.json`;
    a.click();
  };

  const currentMode: ClipCreationMode = draft.clipCreationMode || 'clip-segment';

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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          background: '#1a1a1a',
          padding: '7px 10px',
          borderRadius: 4,
          border: '1px solid #303030',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
          <span style={{ color: '#9e9e9e', fontSize: 11, whiteSpace: 'nowrap' }}>
            Active Scheme:
          </span>
          <select
            className="pr-select"
            style={{ flex: 1, fontWeight: 600 }}
            value={activeScheme.id}
            onChange={(e) => {
              const found = schemes.find((s) => s.id === e.target.value);
              if (found) onSelectScheme(found);
            }}
          >
            {schemes.map((s) => (
              <option key={s.id} value={s.id}>
                {s.clonedFromReference ? `★ [Cloned] ${s.name}` : s.name}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: 'flex', gap: 5 }}>
          <button className="pr-btn" onClick={handleCreateNewScheme} title="Create New Scheme">
            <Plus size={12} />
            New Scheme
          </button>
          <button className="pr-btn" onClick={handleExportJson} title="Export Scheme JSON">
            <Download size={12} />
            JSON
          </button>
          {!draft.isBuiltIn && schemes.length > 1 && (
            <button
              className="pr-btn"
              onClick={() => onDeleteScheme(draft.id)}
              title="Delete Custom Scheme"
              style={{ color: '#f87171' }}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Clip Mode Selector: Clip Out a Segment vs Create an Edit into Target Length */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
          background: '#191919',
          padding: 8,
          borderRadius: 4,
          border: '1px solid #2b2b2b',
        }}
      >
        <button
          type="button"
          onClick={() => setDraft({ ...draft, clipCreationMode: 'clip-segment' })}
          style={{
            padding: '8px 10px',
            borderRadius: 4,
            border:
              currentMode === 'clip-segment' ? '1px solid #2d8ceb' : '1px solid #303030',
            background:
              currentMode === 'clip-segment' ? 'rgba(45, 140, 235, 0.2)' : '#141414',
            color: '#fff',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Scissors size={13} color="#60a5fa" />
            Clip Out a Segment
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
            Extract a continuous segment of the determined length
          </div>
        </button>

        <button
          type="button"
          onClick={() => setDraft({ ...draft, clipCreationMode: 'condensed-edit' })}
          style={{
            padding: '8px 10px',
            borderRadius: 4,
            border:
              currentMode === 'condensed-edit' ? '1px solid #2d8ceb' : '1px solid #303030',
            background:
              currentMode === 'condensed-edit' ? 'rgba(45, 140, 235, 0.2)' : '#141414',
            color: '#fff',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Film size={13} color="#a78bfa" />
            Edit Video into Length
          </div>
          <div style={{ fontSize: 10, color: '#9ca3af', marginTop: 2 }}>
            Stitch best moments across the video into determined length
          </div>
        </button>
      </div>

      {draft.clonedFromReference && (
        <div
          style={{
            padding: '6px 10px',
            background: 'rgba(139, 92, 246, 0.14)',
            border: '1px solid rgba(139, 92, 246, 0.4)',
            borderRadius: 4,
            fontSize: 10.5,
            color: '#ddd6fe',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Wand2 size={13} color="#a78bfa" />
          <span>
            <strong>Cloned from Reference:</strong> {draft.clonedFromReference.referenceFileName} (
            {draft.clonedFromReference.averageShotLength}s ASL •{' '}
            {draft.clonedFromReference.cutsPerMinute} cuts/min •{' '}
            {Math.round(draft.clonedFromReference.beatSyncRatio * 100)}% beat-sync)
          </span>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          background: '#191919',
          padding: 10,
          borderRadius: 4,
          border: '1px solid #2b2b2b',
        }}
      >
        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Scheme Name
          </label>
          <input
            type="text"
            className="pr-input"
            style={{ width: '100%' }}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Pacing &amp; Cut Cadence Profile
          </label>
          <select
            className="pr-select"
            style={{ width: '100%' }}
            value={draft.pacingProfile}
            onChange={(e) => setDraft({ ...draft, pacingProfile: e.target.value as any })}
          >
            <option value="hyper-fast">Hyper-Fast Hook (0.9s - 1.6s ASL)</option>
            <option value="fast-social">Fast Social / TikTok (1.6s - 2.5s ASL)</option>
            <option value="balanced">Balanced Reels / Podcast (2.5s - 4.0s ASL)</option>
            <option value="cinematic">Cinematic Story (4.0s+ ASL)</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Target Clip Duration:{' '}
            <span className="pr-timecode">{draft.targetClipDuration}s</span> (Generate{' '}
            {draft.maxClipsCount} clips)
          </label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="range"
              min={8}
              max={60}
              value={draft.targetClipDuration}
              onChange={(e) =>
                setDraft({ ...draft, targetClipDuration: parseInt(e.target.value, 10) })
              }
              style={{ flex: 1 }}
            />
            <select
              className="pr-select"
              value={draft.maxClipsCount}
              onChange={(e) =>
                setDraft({ ...draft, maxClipsCount: parseInt(e.target.value, 10) })
              }
            >
              {[1, 2, 3, 4, 5, 6, 8, 10, 12].map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'Clip' : 'Clips'}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Target Average Shot Length (ASL):{' '}
            <span className="pr-timecode">{draft.targetAvgShotLength.toFixed(1)}s</span>
          </label>
          <input
            type="range"
            min={0.9}
            max={6.5}
            step={0.1}
            value={draft.targetAvgShotLength}
            onChange={(e) =>
              setDraft({ ...draft, targetAvgShotLength: parseFloat(e.target.value) })
            }
            style={{ width: '100%' }}
          />
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            9:16 Subject Tracking Mode
          </label>
          <select
            className="pr-select"
            style={{ width: '100%' }}
            value={draft.trackingMode}
            onChange={(e) => setDraft({ ...draft, trackingMode: e.target.value as any })}
          >
            <option value="primary-subject">Primary Salient Subject (Auto-Center)</option>
            <option value="face-speaker">Active Speaker / Face Lock</option>
            <option value="action-motion">High-Velocity Action / Vehicle Tracker</option>
            <option value="center-lock">Fixed Center 9:16 Crop</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Camera Smoothing:{' '}
            <span className="pr-timecode">{Math.round(draft.trackingSmoothing * 100)}%</span> •
            Punch-In: <span className="pr-timecode">{draft.punchInZoom.toFixed(2)}x</span>
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="range"
              min={0.3}
              max={0.96}
              step={0.02}
              value={draft.trackingSmoothing}
              onChange={(e) =>
                setDraft({ ...draft, trackingSmoothing: parseFloat(e.target.value) })
              }
              style={{ flex: 1 }}
              title="Camera Spring Smoothing"
            />
            <input
              type="range"
              min={1.0}
              max={1.38}
              step={0.02}
              value={draft.punchInZoom}
              onChange={(e) => setDraft({ ...draft, punchInZoom: parseFloat(e.target.value) })}
              style={{ flex: 1 }}
              title="Emphasis Cut Punch-In Zoom"
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={draft.beatSyncCuts}
            onChange={(e) => setDraft({ ...draft, beatSyncCuts: e.target.checked })}
          />
          <span style={{ color: '#c4c4c4', fontSize: 11 }}>
            Snap sub-cuts to audio transients &amp; strip silences &gt;{draft.silenceThresholdMs}ms
          </span>
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedNotice && (
            <span style={{ color: '#4ade80', fontSize: 11 }}>{savedNotice}</span>
          )}
          <button className="pr-btn" onClick={() => handleSave(false)}>
            <Save size={12} />
            Save Scheme
          </button>
          <button className="pr-btn pr-btn-primary" onClick={() => handleSave(true)}>
            <Sparkles size={12} />
            Save &amp; Apply to 9:16 Clips
          </button>
        </div>
      </div>
    </div>
  );
};
