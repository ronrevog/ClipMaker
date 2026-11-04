---
name: ai-video-editor
description: >-
  Comprehensive AI Video Editing & 9:16 Viral NLE Director skill for ClipMaker Studio.
  Covers Auto-Editor silence stripping, word-level karaoke caption timing, 2-speaker podcast
  split-screen & active-speaker switching, blurred 9:16 background fill, beat-synced cutting,
  speed ramping, and natural-language-to-timeline EDL operations.
---

# ClipMaker AI Video Editor & 9:16 NLE Director Skill

Use this skill whenever designing, extending, or executing AI-driven video editing operations in **ClipMaker Studio**.

---

## 1. Core AI Video Editing Tools Available in ClipMaker (`src/services/aiVideoEditorTools.ts`)

| Tool / Operation | Copilot Operation Type | What It Does |
| :--- | :--- | :--- |
| **Auto-Silence Jump Cutter** | `strip_silence` | Scans the audio RMS waveform (`waveformPeaks` & `perSecondTelemetry`) to detect silent / dead-air gaps (`> 0.35s` below `silenceThreshold`), splits around speech islands with `0.12s` breath padding, and ripple-deletes all awkward pauses. |
| **Beat-Sync & Transient Cutter** | `beat_sync_cuts` | Aligns sub-cut transitions to detected audio transients (`audioPeakTimestamps`) or slices a long take on musical/vocal beats for high-retention rhythm. |
| **Word-Level Karaoke Captions** | `generate_word_captions` | Generates word-by-word timed `CaptionSegment` cues (`words: [{ word, start, end }]`) and renders live highlighted active words in `hormozi-bold`, `neon-karaoke`, `premiere-minimal`, or `cinema-serif` styles. |
| **2-Speaker Split-Screen & Auto-Switch** | `set_layout_mode` | Switches the 9:16 output between `'blurred'` (16:9 fitted over soft Gaussian-blurred 9:16 background), `'split-screen'` (Top/Bottom dual-speaker 9:16 podcast stack), `'auto-switch'` (alternating Left/Right speaker camera cuts), or `'black'` (clean letterbox). |
| **Speed Ramp / Playback Rate** | `set_playback_speed` | Sets timeline & video playback speed (`0.5x` slow-mo to `2.0x` fast-forward) on the active clip and sub-cuts. |
| **Distortion-Free 9:16 Zoom & Reframe** | `set_zoom` | Sets `zoom` across all timeline sub-cuts (`0.56x` Fit Full 16:9 Width ↔ `1.00x` Full 9:16 Height / No Zoom ↔ `1.50x` Punch-In). |

---

## 2. Natural Language → NLE Edit Decision List (EDL) Mapping Rules

1. **"Remove dead air" / "Cut out the pauses" / "Jump-cut the silence"**:
   - Emit `{"type": "strip_silence", "silenceThreshold": 0.18, "summary": "Stripped Dead Air & Pauses"}`.
2. **"Put both speakers on screen" / "Split screen podcast layout" / "Top and bottom split screen"**:
   - Emit `{"type": "set_layout_mode", "layoutMode": "split-screen", "summary": "9:16 Top/Bottom Split-Screen"}`.
3. **"Switch back and forth between the two speakers" / "Auto-switch cameras"**:
   - Emit `{"type": "set_layout_mode", "layoutMode": "auto-switch", "summary": "2-Speaker Auto Camera Switch"}`.
4. **"Add blurred background" / "Fill the black bars with blur" / "Fit 16:9 with blurred background"**:
   - Emit `{"type": "set_layout_mode", "layoutMode": "blurred", "zoom": 0.56, "summary": "Fit 16:9 + Blurred 9:16 Background"}`.
5. **"Cut to the beat" / "Sync cuts to audio peaks"**:
   - Emit `{"type": "beat_sync_cuts", "summary": "Beat-Synced Cuts to Audio Peaks"}`.
6. **"Generate word-by-word captions" / "Add Hormozi karaoke subtitles" / "Transcribe this clip"**:
   - Emit `{"type": "generate_word_captions", "captionStyle": "hormozi-bold", "summary": "Generated Word-Level Karaoke Captions"}`.
7. **"Speed it up to 1.25x" / "Slow motion 0.5x"**:
   - Emit `{"type": "set_playback_speed", "speed": 1.25, "summary": "Playback Speed: 1.25x"}`.
