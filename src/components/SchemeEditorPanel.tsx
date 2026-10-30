import React, { useEffect, useState } from 'react';
import {
  Copy,
  Download,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import { EditingScheme } from '../types/editor';

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
      {/* Top Selector & New/Duplicate/Export Actions */}
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

      {/* Cloned Reference Badge if Scheme came from Reference Cloner */}
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

      {/* Editable Criteria Grid */}
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
            <span className="pr-timecode">{draft.targetClipDuration}s</span> (Max{' '}
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
              <option value={3}>3 Clips</option>
              <option value={4}>4 Clips</option>
              <option value={5}>5 Clips</option>
              <option value={6}>6 Clips</option>
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

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Audio Peak Weight ({Math.round(draft.audioPeakWeight * 100)}%) vs Motion Weight (
            {Math.round(draft.visualMotionWeight * 100)}%)
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="range"
              min={0.1}
              max={1.0}
              step={0.05}
              value={draft.audioPeakWeight}
              onChange={(e) => setDraft({ ...draft, audioPeakWeight: parseFloat(e.target.value) })}
              style={{ flex: 1 }}
            />
            <input
              type="range"
              min={0.1}
              max={1.0}
              step={0.05}
              value={draft.visualMotionWeight}
              onChange={(e) =>
                setDraft({ ...draft, visualMotionWeight: parseFloat(e.target.value) })
              }
              style={{ flex: 1 }}
            />
          </div>
        </div>

        <div>
          <label style={{ display: 'block', fontSize: 10.5, color: '#999', marginBottom: 3 }}>
            Caption Theme &amp; Social Safe Zone
          </label>
          <div style={{ display: 'flex', gap: 6 }}>
            <select
              className="pr-select"
              style={{ flex: 1 }}
              value={draft.captionStyle}
              onChange={(e) => setDraft({ ...draft, captionStyle: e.target.value as any })}
            >
              <option value="hormozi-bold">Hormozi Impact Bold</option>
              <option value="premiere-minimal">Premiere Pro Minimal</option>
              <option value="neon-karaoke">Neon Karaoke Highlight</option>
              <option value="cinema-serif">Cinema Serif ("SUMMER")</option>
            </select>
            <select
              className="pr-select"
              value={draft.safeZoneGuide}
              onChange={(e) => setDraft({ ...draft, safeZoneGuide: e.target.value as any })}
            >
              <option value="tiktok">TikTok</option>
              <option value="reels">Reels</option>
              <option value="shorts">Shorts</option>
              <option value="none">No Guide</option>
            </select>
          </div>
        </div>
      </div>

      {/* Bottom Save & Apply Actions */}
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
