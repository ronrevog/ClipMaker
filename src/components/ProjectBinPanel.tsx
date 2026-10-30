import React, { useState } from 'react';
import {
  Film,
  FolderPlus,
  Grid,
  List,
  Search,
  Sparkles,
  Trash2,
  Wand2,
} from 'lucide-react';
import {
  EditingScheme,
  GeneratedClip,
  ReferenceVideoAnalysis,
  SourceVideoAsset,
} from '../types/editor';
import { formatSMPTETimecode } from '../services/clipGenerator';

interface ProjectBinPanelProps {
  focused: boolean;
  onFocus: () => void;
  sourceAssets: SourceVideoAsset[];
  activeSourceId: string;
  onSelectSource: (asset: SourceVideoAsset) => void;
  generatedClips: GeneratedClip[];
  activeClipId: string | null;
  onSelectClip: (clip: GeneratedClip) => void;
  schemes: EditingScheme[];
  activeSchemeId: string;
  onSelectScheme: (scheme: EditingScheme) => void;
  referenceAnalyses: ReferenceVideoAnalysis[];
  onUploadSourceFile: (file: File) => void;
  onUploadReferenceFile: (file: File) => void;
  onOpenSchemesTab: () => void;
  onOpenReferenceTab: () => void;
}

export const ProjectBinPanel: React.FC<ProjectBinPanelProps> = ({
  focused,
  onFocus,
  sourceAssets,
  activeSourceId,
  onSelectSource,
  generatedClips,
  activeClipId,
  onSelectClip,
  schemes,
  activeSchemeId,
  onSelectScheme,
  referenceAnalyses,
  onUploadSourceFile,
  onUploadReferenceFile,
  onOpenSchemesTab,
  onOpenReferenceTab,
}) => {
  const [activeBinTab, setActiveBinTab] = useState<'project' | 'clips' | 'schemes' | 'references'>(
    'project'
  );
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [searchQuery, setSearchQuery] = useState('');

  const filteredClips = generatedClips.filter((c) =>
    c.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <section
      className={`pr-panel ${focused ? 'focused' : ''}`}
      style={{ width: '28%', minWidth: 270, maxWidth: 400 }}
      onMouseDown={onFocus}
    >
      {/* Premiere Project Bin Header Tabs */}
      <div className="pr-panel-tabs">
        <button
          className={`pr-panel-tab ${activeBinTab === 'project' ? 'active' : ''}`}
          onClick={() => setActiveBinTab('project')}
        >
          Project: ClipMaker ≡
        </button>
        <button
          className={`pr-panel-tab ${activeBinTab === 'clips' ? 'active' : ''}`}
          onClick={() => setActiveBinTab('clips')}
        >
          9:16 Clips ({generatedClips.length})
        </button>
        <button
          className={`pr-panel-tab ${activeBinTab === 'schemes' ? 'active' : ''}`}
          onClick={() => setActiveBinTab('schemes')}
        >
          Schemes ({schemes.length})
        </button>
        <button
          className={`pr-panel-tab ${activeBinTab === 'references' ? 'active' : ''}`}
          onClick={() => setActiveBinTab('references')}
        >
          Ref Styles ({referenceAnalyses.length})
        </button>
      </div>

      {/* Sub-header Search Bar & Project Info */}
      <div
        style={{
          padding: '6px 8px',
          background: '#1c1c1c',
          borderBottom: '1px solid #141414',
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            fontSize: 10.5,
            color: '#9a9a9a',
          }}
        >
          <span>📁 ClipMaker_Social_9x16.prproj</span>
          <span>
            {generatedClips.length} sequences • {sourceAssets.length} source
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search
              size={11}
              color="#777"
              style={{ position: 'absolute', left: 6, top: 6 }}
            />
            <input
              type="text"
              className="pr-input"
              style={{ width: '100%', paddingLeft: 22, height: 22 }}
              placeholder="Search media, 9:16 clips, or schemes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Bin Items Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {activeBinTab === 'project' && (
          <div
            style={{
              display: viewMode === 'grid' ? 'grid' : 'flex',
              gridTemplateColumns: '1fr 1fr',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {/* Source Media Cards (matching screenshot's two thumbnail cards!) */}
            {sourceAssets.map((asset) => {
              const selected = asset.id === activeSourceId;
              return (
                <div
                  key={asset.id}
                  onClick={() => onSelectSource(asset)}
                  style={{
                    background: selected ? '#2d3744' : '#1a1a1a',
                    border: selected ? '1px solid #2d8ceb' : '1px solid #2e2e2e',
                    borderRadius: 3,
                    padding: 6,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      height: 68,
                      background: 'linear-gradient(135deg, #2d2926 0%, #4b382a 50%, #d99e4e 100%)',
                      borderRadius: 2,
                      position: 'relative',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 5,
                    }}
                  >
                    <Film size={24} color="#ffffff" opacity={0.85} />
                    <span
                      style={{
                        position: 'absolute',
                        right: 4,
                        bottom: 4,
                        background: '#2d8ceb',
                        color: '#fff',
                        fontSize: 9,
                        fontWeight: 700,
                        padding: '1px 4px',
                        borderRadius: 2,
                      }}
                    >
                      16:9 SRC
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 10.5,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 95,
                      }}
                    >
                      {asset.name}
                    </span>
                    <span className="pr-timecode-muted" style={{ fontSize: 10 }}>
                      {formatSMPTETimecode(asset.duration).slice(3)}
                    </span>
                  </div>
                </div>
              );
            })}

            {/* Generated 9:16 Social Clips in Project Bin */}
            {filteredClips.map((clip) => {
              const selected = clip.id === activeClipId;
              return (
                <div
                  key={clip.id}
                  onClick={() => onSelectClip(clip)}
                  style={{
                    background: selected ? '#263849' : '#1a1a1a',
                    border: selected ? '1px solid #2d8ceb' : '1px solid #2e2e2e',
                    borderRadius: 3,
                    padding: 6,
                    cursor: 'pointer',
                  }}
                >
                  <div
                    style={{
                      height: 68,
                      background: 'linear-gradient(160deg, #133a1b 0%, #1e6e75 100%)',
                      borderRadius: 2,
                      position: 'relative',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginBottom: 5,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 800,
                        color: '#facc15',
                        letterSpacing: 0.4,
                      }}
                    >
                      {clip.captionText.slice(0, 14)}
                    </span>
                    <span style={{ fontSize: 9.5, color: '#d1fae5', marginTop: 2 }}>
                      {clip.subCuts.length} cuts • {clip.zoomScale}x
                    </span>
                    <span
                      style={{
                        position: 'absolute',
                        left: 4,
                        top: 4,
                        background: 'rgba(16, 185, 129, 0.25)',
                        border: '1px solid #10b981',
                        color: '#6ee7b7',
                        fontSize: 8.5,
                        fontWeight: 700,
                        padding: '0px 4px',
                        borderRadius: 2,
                      }}
                    >
                      {clip.viralScore}%
                    </span>
                    <span
                      style={{
                        position: 'absolute',
                        right: 4,
                        bottom: 4,
                        background: '#46a3ff',
                        color: '#000',
                        fontSize: 8.5,
                        fontWeight: 700,
                        padding: '1px 4px',
                        borderRadius: 2,
                      }}
                    >
                      9:16 SEQ
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      fontSize: 10.5,
                    }}
                  >
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        maxWidth: 95,
                        color: selected ? '#fff' : '#d0d0d0',
                      }}
                    >
                      {clip.name}
                    </span>
                    <span className="pr-timecode-muted" style={{ fontSize: 10 }}>
                      {formatSMPTETimecode(clip.duration).slice(3)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeBinTab === 'clips' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {filteredClips.map((clip) => {
              const selected = clip.id === activeClipId;
              return (
                <div
                  key={clip.id}
                  onClick={() => onSelectClip(clip)}
                  style={{
                    padding: '7px 9px',
                    borderRadius: 3,
                    background: selected ? 'rgba(45, 140, 235, 0.2)' : '#1b1b1b',
                    border: selected ? '1px solid #2d8ceb' : '1px solid #2d2d2d',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                    <span style={{ fontWeight: 600, color: '#ececec' }}>{clip.name}</span>
                    <span
                      style={{
                        fontSize: 10,
                        color: '#4ade80',
                        fontWeight: 600,
                      }}
                    >
                      Score {clip.viralScore}%
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#999' }}>{clip.hookReason}</div>
                </div>
              );
            })}
          </div>
        )}

        {activeBinTab === 'schemes' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {schemes.map((s) => {
              const active = s.id === activeSchemeId;
              return (
                <div
                  key={s.id}
                  onClick={() => {
                    onSelectScheme(s);
                    onOpenSchemesTab();
                  }}
                  style={{
                    padding: '7px 9px',
                    borderRadius: 3,
                    background: active ? 'rgba(45, 140, 235, 0.18)' : '#1b1b1b',
                    border: active ? '1px solid #2d8ceb' : '1px solid #2d2d2d',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ fontWeight: 600, color: '#e5e5e5' }}>
                      {s.clonedFromReference ? `★ ${s.name}` : s.name}
                    </span>
                    <span className="pr-timecode" style={{ fontSize: 10 }}>
                      {s.targetAvgShotLength}s ASL
                    </span>
                  </div>
                  <div style={{ fontSize: 10, color: '#8e8e8e', marginTop: 2 }}>
                    {s.description.slice(0, 75)}...
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {activeBinTab === 'references' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {referenceAnalyses.map((ref) => (
              <div
                key={ref.id}
                onClick={onOpenReferenceTab}
                style={{
                  padding: '7px 9px',
                  borderRadius: 3,
                  background: '#1b1b1b',
                  border: '1px solid #352b54',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 600, color: '#ddd6fe' }}>{ref.fileName}</span>
                  <span className="pr-timecode" style={{ fontSize: 10 }}>
                    {ref.telemetry.averageShotLength}s ASL
                  </span>
                </div>
                <div style={{ fontSize: 10, color: '#999', marginTop: 2 }}>
                  {ref.telemetry.detectedCutCount} cuts • {ref.telemetry.cutsPerMinute}/min •{' '}
                  {Math.round(ref.telemetry.beatSyncRatio * 100)}% beat-sync
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bottom Project Bin Toolbar matching Premiere screenshot */}
      <div
        style={{
          height: 26,
          background: '#1c1c1c',
          borderTop: '1px solid #141414',
          padding: '0 8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <button
            className={`pr-icon-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List View"
          >
            <List size={12} />
          </button>
          <button
            className={`pr-icon-btn ${viewMode === 'grid' ? 'active' : ''}`}
            onClick={() => setViewMode('grid')}
            title="Icon Grid View"
          >
            <Grid size={12} />
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <label
            className="pr-icon-btn"
            style={{ cursor: 'pointer' }}
            title="Import Source Video"
          >
            <FolderPlus size={12} />
            <input
              type="file"
              accept="video/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUploadSourceFile(f);
              }}
            />
          </label>
          <label
            className="pr-icon-btn"
            style={{ cursor: 'pointer' }}
            title="Upload Reference Video to Clone Style"
          >
            <Wand2 size={12} color="#a78bfa" />
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
          <button
            className="pr-icon-btn"
            onClick={onOpenSchemesTab}
            title="Open Editing Schemes Builder"
          >
            <Sparkles size={12} color="#46a3ff" />
          </button>
        </div>
      </div>
    </section>
  );
};
