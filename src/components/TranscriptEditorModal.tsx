import React, { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Cpu,
  FileText,
  Mic,
  Play,
  Plus,
  Replace,
  Scissors,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { runLocalWhisperWordTranscription } from '../services/sotaStudioEngines';
import { CaptionSegment, GeneratedClip, SourceVideoAsset } from '../types/editor';

interface TranscriptEditorModalProps {
  isOpen: boolean;
  activeClip: GeneratedClip | null;
  activeSource: SourceVideoAsset | null;
  clipPlayheadTime: number;
  isTranscribing: boolean;
  transcriptionProgress: number;
  onClose: () => void;
  onUpdateClipCaptions: (captions: CaptionSegment[], fallbackCaptionText?: string) => void;
  onUpdateSourceTranscript: (segments: CaptionSegment[]) => void;
  onSeekClipTime: (clipSec: number) => void;
  onSeekSourceTime: (sourceSec: number) => void;
  onRunAITranscription: () => void;
}

function rebuildWordsForSegment(text: string, start: number, end: number) {
  const cleanTokens = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const dur = Math.max(0.15, end - start);
  const step = dur / Math.max(1, cleanTokens.length);
  const words = cleanTokens.map((w, idx) => ({
    word: w,
    start: Number((start + idx * step).toFixed(2)),
    end: Number((start + (idx + 1) * step).toFixed(2)),
  }));
  const highlightWord =
    cleanTokens.reduce((longest, cur) => (cur.length > longest.length ? cur : longest), '') ||
    cleanTokens[0];
  return { words, highlightWord };
}

function formatSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0.0';
  return sec.toFixed(1);
}

export const TranscriptEditorModal: React.FC<TranscriptEditorModalProps> = ({
  isOpen,
  activeClip,
  activeSource,
  clipPlayheadTime,
  isTranscribing,
  transcriptionProgress,
  onClose,
  onUpdateClipCaptions,
  onUpdateSourceTranscript,
  onSeekClipTime,
  onSeekSourceTime,
  onRunAITranscription,
}) => {
  const [activeTab, setActiveTab] = useState<'clip' | 'source'>('clip');
  const [viewMode, setViewMode] = useState<'segments' | 'bulk'>('segments');
  const [draftSegments, setDraftSegments] = useState<CaptionSegment[]>([]);
  const [fallbackSingleText, setFallbackSingleText] = useState<string>('');
  const [bulkText, setBulkText] = useState<string>('');
  const [findQuery, setFindQuery] = useState<string>('');
  const [replaceQuery, setReplaceQuery] = useState<string>('');
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const [isLocalWhisperRunning, setIsLocalWhisperRunning] = useState<boolean>(false);
  const [localWhisperLabel, setLocalWhisperLabel] = useState<string>('');

  // Sync draft state when modal opens or tab/clip changes
  useEffect(() => {
    if (!isOpen) return;
    if (activeTab === 'clip') {
      const segs = activeClip?.captions ? [...activeClip.captions] : [];
      if (segs.length === 0 && activeClip?.captionText?.trim()) {
        const dur = Math.max(1, activeClip.duration || 10);
        const built = rebuildWordsForSegment(activeClip.captionText, 0, dur);
        const initialSeg: CaptionSegment = {
          id: `cap-init-${Date.now()}`,
          start: 0,
          end: Number(dur.toFixed(2)),
          text: activeClip.captionText,
          words: built.words,
          highlightWord: built.highlightWord,
        };
        setDraftSegments([initialSeg]);
        setBulkText(activeClip.captionText);
      } else {
        setDraftSegments(
          segs.map((s) => ({
            ...s,
            words: s.words ? [...s.words] : rebuildWordsForSegment(s.text, s.start, s.end).words,
          }))
        );
        setBulkText(segs.map((s) => s.text).join('\n'));
      }
      setFallbackSingleText(activeClip?.captionText || '');
    } else {
      const srcSegs = activeSource?.transcriptSegments ? [...activeSource.transcriptSegments] : [];
      setDraftSegments(
        srcSegs.map((s) => ({
          ...s,
          words: s.words ? [...s.words] : rebuildWordsForSegment(s.text, s.start, s.end).words,
        }))
      );
      setBulkText(srcSegs.map((s) => s.text).join('\n'));
    }
  }, [isOpen, activeTab, activeClip?.id, activeClip?.captions, activeSource?.transcriptSegments]);

  const maxDuration = useMemo(() => {
    if (activeTab === 'clip') return Math.max(1, activeClip?.duration || 30);
    return Math.max(1, activeSource?.duration || 60);
  }, [activeTab, activeClip?.duration, activeSource?.duration]);

  if (!isOpen) return null;

  const commitSegments = (nextSegs: CaptionSegment[], showNotice?: string) => {
    const sorted = [...nextSegs].sort((a, b) => a.start - b.start);
    setDraftSegments(sorted);
    setBulkText(sorted.map((s) => s.text).join('\n'));
    if (activeTab === 'clip') {
      onUpdateClipCaptions(sorted, sorted[0]?.text ?? fallbackSingleText);
    } else {
      onUpdateSourceTranscript(sorted);
    }
    if (showNotice) {
      setSavedNotice(showNotice);
      setTimeout(() => setSavedNotice(null), 2200);
    }
  };

  const handleSegmentTextChange = (id: string, newText: string) => {
    const updated = draftSegments.map((seg) => {
      if (seg.id !== id) return seg;
      const { words, highlightWord } = rebuildWordsForSegment(newText, seg.start, seg.end);
      return {
        ...seg,
        text: newText,
        words,
        highlightWord,
      };
    });
    commitSegments(updated);
  };

  const handleSegmentTimeChange = (id: string, field: 'start' | 'end', value: number) => {
    if (!Number.isFinite(value)) return;
    const updated = draftSegments.map((seg) => {
      if (seg.id !== id) return seg;
      const nextStart =
        field === 'start'
          ? Math.max(0, Math.min(seg.end - 0.2, Number(value.toFixed(2))))
          : seg.start;
      const nextEnd =
        field === 'end'
          ? Math.max(seg.start + 0.2, Math.min(maxDuration, Number(value.toFixed(2))))
          : seg.end;
      const { words, highlightWord } = rebuildWordsForSegment(seg.text, nextStart, nextEnd);
      return {
        ...seg,
        start: nextStart,
        end: nextEnd,
        words,
        highlightWord,
      };
    });
    commitSegments(updated);
  };

  const handleAddSegment = (afterIndex?: number) => {
    let startT = Number(Math.max(0, clipPlayheadTime).toFixed(2));
    if (typeof afterIndex === 'number' && draftSegments[afterIndex]) {
      startT = Number(draftSegments[afterIndex].end.toFixed(2));
    } else if (draftSegments.length > 0) {
      startT = Number(draftSegments[draftSegments.length - 1].end.toFixed(2));
    }
    if (startT >= maxDuration - 0.3) {
      startT = Math.max(0, Number((maxDuration - 2.0).toFixed(2)));
    }
    const endT = Number(Math.min(maxDuration, startT + 2.5).toFixed(2));
    const defaultText = 'New caption line';
    const { words, highlightWord } = rebuildWordsForSegment(defaultText, startT, endT);
    const newSeg: CaptionSegment = {
      id: `cap-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      start: startT,
      end: Math.max(startT + 0.3, endT),
      text: defaultText,
      words,
      highlightWord,
    };
    commitSegments([...draftSegments, newSeg], 'Added segment');
  };

  const handleSplitSegment = (seg: CaptionSegment) => {
    const wordsList = seg.text.trim().split(/\s+/).filter(Boolean);
    const dur = seg.end - seg.start;
    if (dur < 0.6) return;
    const midTime = Number((seg.start + dur / 2).toFixed(2));
    const halfIdx = Math.max(1, Math.ceil(wordsList.length / 2));
    const firstText = wordsList.slice(0, halfIdx).join(' ') || seg.text;
    const secondText = wordsList.slice(halfIdx).join(' ') || '...';

    const firstBuilt = rebuildWordsForSegment(firstText, seg.start, midTime);
    const secondBuilt = rebuildWordsForSegment(secondText, midTime, seg.end);

    const firstSeg: CaptionSegment = {
      ...seg,
      end: midTime,
      text: firstText,
      words: firstBuilt.words,
      highlightWord: firstBuilt.highlightWord,
    };
    const secondSeg: CaptionSegment = {
      id: `cap-split-${Date.now()}`,
      start: midTime,
      end: seg.end,
      text: secondText,
      words: secondBuilt.words,
      highlightWord: secondBuilt.highlightWord,
    };

    const next = draftSegments.flatMap((s) => (s.id === seg.id ? [firstSeg, secondSeg] : [s]));
    commitSegments(next, 'Split segment in two');
  };

  const handleDeleteSegment = (id: string) => {
    const next = draftSegments.filter((s) => s.id !== id);
    commitSegments(next, 'Deleted segment');
  };

  const handleFindAndReplaceAll = () => {
    if (!findQuery.trim()) return;
    const escaped = findQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    let replacedCount = 0;

    const updated = draftSegments.map((seg) => {
      if (!regex.test(seg.text)) return seg;
      replacedCount++;
      const newText = seg.text.replace(regex, replaceQuery);
      const { words, highlightWord } = rebuildWordsForSegment(newText, seg.start, seg.end);
      return {
        ...seg,
        text: newText,
        words,
        highlightWord,
      };
    });

    if (replacedCount > 0) {
      commitSegments(updated, `Replaced in ${replacedCount} segment(s)`);
    } else {
      setSavedNotice('No matching words found');
      setTimeout(() => setSavedNotice(null), 2000);
    }
  };

  const handleApplyBulkText = () => {
    const lines = bulkText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      commitSegments([], 'Cleared transcript');
      return;
    }

    // If line count matches existing segments, preserve existing start/end timings
    if (lines.length === draftSegments.length) {
      const updated = draftSegments.map((seg, idx) => {
        const text = lines[idx];
        const { words, highlightWord } = rebuildWordsForSegment(text, seg.start, seg.end);
        return { ...seg, text, words, highlightWord };
      });
      commitSegments(updated, 'Applied bulk script edits');
      return;
    }

    // Otherwise distribute evenly across maxDuration
    const step = maxDuration / lines.length;
    const rebuilt: CaptionSegment[] = lines.map((text, idx) => {
      const start = Number((idx * step).toFixed(2));
      const end = Number(Math.min(maxDuration, (idx + 1) * step).toFixed(2));
      const { words, highlightWord } = rebuildWordsForSegment(text, start, end);
      return {
        id: draftSegments[idx]?.id || `cap-bulk-${Date.now()}-${idx}`,
        start,
        end,
        text,
        words,
        highlightWord,
      };
    });
    commitSegments(rebuilt, `Updated ${rebuilt.length} segments from script`);
  };

  const handleRunLocalOnDeviceWhisper = async () => {
    if (!activeSource?.url || isLocalWhisperRunning) return;
    setIsLocalWhisperRunning(true);
    setLocalWhisperLabel('Loading Whisper...');
    try {
      const startSec = activeTab === 'clip' && activeClip ? activeClip.sourceStart : 0;
      const endSec =
        activeTab === 'clip' && activeClip
          ? activeClip.sourceEnd
          : activeSource.duration || 60;
      const segments = await runLocalWhisperWordTranscription(
        activeSource.url,
        startSec,
        Math.max(1, endSec - startSec),
        (msg: string) => {
          setLocalWhisperLabel(msg);
        }
      );
      if (segments.length > 0) {
        commitSegments(segments, `Whisper transcribed ${segments.length} timed segments`);
      } else {
        setSavedNotice('No speech detected in audio range');
        setTimeout(() => setSavedNotice(null), 2500);
      }
    } catch (err: any) {
      setSavedNotice(`Whisper fallback: ${err?.message || 'Use Auto-Transcribe'}`);
      setTimeout(() => setSavedNotice(null), 3000);
    } finally {
      setIsLocalWhisperRunning(false);
      setLocalWhisperLabel('');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 820,
          maxHeight: '86vh',
          background: '#111115',
          border: '1px solid var(--border-strong)',
          borderRadius: 8,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.65)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--bg-panel-header)',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <FileText size={14} color="#c084fc" />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)' }}>
              Transcript & Captions Editor
            </span>
            <span className="badge-subtle">
              {draftSegments.length} {draftSegments.length === 1 ? 'Segment' : 'Segments'}
            </span>
            {savedNotice && (
              <span
                className="badge-subtle"
                style={{
                  background: 'rgba(16, 185, 129, 0.16)',
                  borderColor: 'rgba(16, 185, 129, 0.45)',
                  color: '#34d399',
                }}
              >
                {savedNotice}
              </span>
            )}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {/* Scope Selector: Active Clip vs Full Source Video */}
            <div className="seg-group">
              <button
                type="button"
                className="seg-item"
                data-active={activeTab === 'clip'}
                onClick={() => setActiveTab('clip')}
              >
                Active Clip Captions (V3)
              </button>
              <button
                type="button"
                className="seg-item"
                data-active={activeTab === 'source'}
                onClick={() => setActiveTab('source')}
              >
                Full Video Transcript
              </button>
            </div>

            {/* View Mode Selector: Timed Segments vs Bulk Script */}
            <div className="seg-group">
              <button
                type="button"
                className="seg-item"
                data-active={viewMode === 'segments'}
                onClick={() => setViewMode('segments')}
              >
                Timed Lines
              </button>
              <button
                type="button"
                className="seg-item"
                data-active={viewMode === 'bulk'}
                onClick={() => setViewMode('bulk')}
              >
                Full Text Script
              </button>
            </div>

            <button
              type="button"
              className="btn btn-icon"
              onClick={onClose}
              title="Close Transcript Editor"
            >
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Toolbar: AI Transcribe + Find & Replace + Add Line */}
        <div
          style={{
            padding: '8px 14px',
            background: '#16161c',
            borderBottom: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {/* Left: Find & Replace */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Search size={12} color="var(--text-muted)" />
              <input
                type="text"
                className="input-field"
                style={{ width: 135, height: 24, fontSize: 11 }}
                placeholder="Find word/name..."
                value={findQuery}
                onChange={(e) => setFindQuery(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Replace size={12} color="var(--text-muted)" />
              <input
                type="text"
                className="input-field"
                style={{ width: 135, height: 24, fontSize: 11 }}
                placeholder="Replace with..."
                value={replaceQuery}
                onChange={(e) => setReplaceQuery(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleFindAndReplaceAll}
              disabled={!findQuery.trim()}
            >
              Replace All
            </button>
          </div>

          {/* Right: AI Transcribe & Add Segment */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleRunLocalOnDeviceWhisper}
              disabled={isLocalWhisperRunning || !activeSource?.url}
              style={{
                borderColor: 'rgba(56, 189, 248, 0.45)',
                background: 'rgba(56, 189, 248, 0.12)',
                color: '#7dd3fc',
              }}
              title="Run on-device Transformers.js Whisper word-level transcription locally in browser (No API key needed)"
            >
              <Cpu size={11} />
              {isLocalWhisperRunning
                ? localWhisperLabel || 'Whisper Running...'
                : 'On-Device Whisper (Local)'}
            </button>

            <button
              type="button"
              className="btn btn-sm"
              onClick={onRunAITranscription}
              disabled={isTranscribing}
              title="Run AI speech-to-text transcription on the audio track"
            >
              <Mic size={11} />
              {isTranscribing
                ? `Transcribing ${transcriptionProgress}%`
                : 'Auto-Transcribe Audio'}
            </button>

            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => handleAddSegment()}
            >
              <Plus size={11} />
              Add Caption Line
            </button>
          </div>
        </div>

        {/* Body: Segment List or Bulk Script Editor */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {viewMode === 'bulk' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-secondary)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>
                  Edit the full transcription below (one caption segment per line). Word-level
                  karaoke timings update automatically when you click Apply.
                </span>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleApplyBulkText}
                >
                  <Check size={11} />
                  Apply Script Changes
                </button>
              </div>
              <textarea
                className="input-field"
                style={{
                  flex: 1,
                  minHeight: 340,
                  padding: 10,
                  fontSize: 12.5,
                  lineHeight: 1.6,
                  fontFamily: 'var(--font-sans)',
                  resize: 'vertical',
                }}
                value={bulkText}
                onChange={(e) => setBulkText(e.target.value)}
                placeholder="Paste or edit full transcript lines here..."
              />
            </div>
          ) : draftSegments.length === 0 ? (
            <div
              style={{
                padding: '44px 20px',
                textAlign: 'center',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                color: 'var(--text-secondary)',
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-main)' }}>
                No transcription segments yet
              </div>
              <div style={{ fontSize: 11.5, maxWidth: 420 }}>
                Click "Auto-Transcribe Audio" to generate word-level timed captions from the video
                audio, or click "Add Caption Line" to type your own.
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={onRunAITranscription}
                  disabled={isTranscribing}
                >
                  <Mic size={12} />
                  {isTranscribing
                    ? `Transcribing ${transcriptionProgress}%`
                    : 'Auto-Transcribe Audio'}
                </button>
                <button type="button" className="btn" onClick={() => handleAddSegment()}>
                  <Plus size={12} />
                  Add Caption Line
                </button>
              </div>
            </div>
          ) : (
            draftSegments.map((seg, idx) => {
              const isCurrent =
                activeTab === 'clip' &&
                clipPlayheadTime >= seg.start - 0.05 &&
                clipPlayheadTime <= seg.end + 0.05;
              const matchesSearch =
                findQuery.trim().length > 0 &&
                seg.text.toLowerCase().includes(findQuery.trim().toLowerCase());

              return (
                <div
                  key={seg.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '32px 152px 1fr auto',
                    gap: 8,
                    alignItems: 'center',
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: isCurrent
                      ? 'rgba(168, 85, 247, 0.14)'
                      : matchesSearch
                        ? 'rgba(245, 158, 11, 0.14)'
                        : 'var(--bg-card)',
                    border: isCurrent
                      ? '1px solid rgba(168, 85, 247, 0.55)'
                      : matchesSearch
                        ? '1px solid rgba(245, 158, 11, 0.55)'
                        : '1px solid var(--border-subtle)',
                  }}
                >
                  {/* Jump / Play Segment Button */}
                  <button
                    type="button"
                    className="btn btn-icon"
                    style={{ width: 26, height: 26 }}
                    onClick={() => {
                      if (activeTab === 'clip') {
                        onSeekClipTime(seg.start);
                      } else {
                        onSeekSourceTime(seg.start);
                      }
                    }}
                    title={`Jump playhead to ${formatSec(seg.start)}s`}
                  >
                    <Play size={11} />
                  </button>

                  {/* Start / End Time Inputs */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      max={Math.max(0, seg.end - 0.2)}
                      className="input-field"
                      style={{
                        width: 64,
                        height: 24,
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        padding: '0 5px',
                      }}
                      value={seg.start}
                      onChange={(e) =>
                        handleSegmentTimeChange(seg.id, 'start', parseFloat(e.target.value))
                      }
                      title="Start time (seconds)"
                    />
                    <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>–</span>
                    <input
                      type="number"
                      step={0.1}
                      min={seg.start + 0.2}
                      max={maxDuration}
                      className="input-field"
                      style={{
                        width: 64,
                        height: 24,
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        padding: '0 5px',
                      }}
                      value={seg.end}
                      onChange={(e) =>
                        handleSegmentTimeChange(seg.id, 'end', parseFloat(e.target.value))
                      }
                      title="End time (seconds)"
                    />
                  </div>

                  {/* Editable Transcript Text */}
                  <input
                    type="text"
                    className="input-field"
                    style={{
                      height: 28,
                      fontSize: 12.5,
                      color: 'var(--text-main)',
                    }}
                    value={seg.text}
                    onChange={(e) => handleSegmentTextChange(seg.id, e.target.value)}
                    placeholder="Type caption text..."
                  />

                  {/* Segment Actions: Split, Insert Below, Delete */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ width: 24, height: 24 }}
                      onClick={() => handleSplitSegment(seg)}
                      title="Split this caption line in half"
                    >
                      <Scissors size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon"
                      style={{ width: 24, height: 24 }}
                      onClick={() => handleAddSegment(idx)}
                      title="Insert new caption line after this one"
                    >
                      <Plus size={11} />
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-danger"
                      style={{ width: 24, height: 24 }}
                      onClick={() => handleDeleteSegment(seg.id)}
                      title="Delete this caption line"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '10px 14px',
            background: 'var(--bg-panel-header)',
            borderTop: '1px solid var(--border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            All edits update the 9:16 video captions and word-by-word karaoke timing live.
          </span>
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
