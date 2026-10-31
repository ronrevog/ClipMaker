import React from 'react';
import {
  Cpu,
  Download,
  Film,
  FolderPlus,
  Home,
  Settings,
  Sparkles,
  Wand2,
} from 'lucide-react';
import { AIProviderId, AIProviderSettings } from '../types/editor';

interface TopMenuBarProps {
  projectName: string;
  activeWorkspace: string;
  onSelectWorkspace: (ws: string) => void;
  aiSettings: AIProviderSettings;
  onChangeProvider: (provider: AIProviderId) => void;
  onOpenAISettings: () => void;
  onTriggerUploadSource: () => void;
  onTriggerUploadReference: () => void;
  onAutoGenerateClips: () => void;
  onExportActiveClip: () => void;
  isExporting: boolean;
  exportProgress: number;
}

const WORKSPACES = [
  'Learning',
  'Assembly',
  'Editing',
  'Style Clone',
  'Schemes',
  'Effects',
  'Audio',
  'Graphics',
];

export const TopMenuBar: React.FC<TopMenuBarProps> = ({
  projectName,
  activeWorkspace,
  onSelectWorkspace,
  aiSettings,
  onChangeProvider,
  onOpenAISettings,
  onTriggerUploadSource,
  onTriggerUploadReference,
  onAutoGenerateClips,
  onExportActiveClip,
  isExporting,
  exportProgress,
}) => {
  return (
    <header className="pr-top-chrome">
      <div className="pr-menubar">
        <div className="pr-menubar-left">
          <span
            style={{
              color: '#e5e7eb',
              fontWeight: 700,
              marginRight: 8,
            }}
          >
            ClipMaker Studio — {projectName}
          </span>
          <span className="pr-menu-item" onClick={onTriggerUploadSource} title="Import Source Video">
            File
          </span>
          <span
            className="pr-menu-item"
            onClick={() => onSelectWorkspace('Schemes')}
            title="Edit Schemes"
          >
            Edit
          </span>
          <span className="pr-menu-item" onClick={onAutoGenerateClips} title="Generate 9:16 Clips">
            Clip
          </span>
          <span
            className="pr-menu-item"
            onClick={onTriggerUploadReference}
            title="Clone Reference Video Editing Style"
          >
            Sequence
          </span>
          <span className="pr-menu-item" onClick={() => onSelectWorkspace('Editing')}>
            Markers
          </span>
          <span className="pr-menu-item" onClick={() => onSelectWorkspace('Graphics')}>
            Graphics
          </span>
          <span className="pr-menu-item" onClick={() => onSelectWorkspace('Effects')}>
            View
          </span>
          <span className="pr-menu-item" onClick={onOpenAISettings}>
            Window
          </span>
          <span className="pr-menu-item" onClick={onOpenAISettings}>
            Help
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              fontSize: 10.5,
              color: '#8e8e8e',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                background: '#38b261',
                display: 'inline-block',
              }}
            />
            Vercel Serverless AI Ready
          </span>
        </div>
      </div>

      <div className="pr-workspace-bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="pr-icon-btn"
            onClick={() => onSelectWorkspace('Editing')}
            title="Reset to Editing Workspace"
          >
            <Home size={13} />
          </button>

          <nav className="pr-workspace-tabs">
            {WORKSPACES.map((ws) => (
              <button
                key={ws}
                className={`pr-workspace-tab ${activeWorkspace === ws ? 'active' : ''}`}
                onClick={() => onSelectWorkspace(ws)}
              >
                {ws}
              </button>
            ))}
          </nav>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="pr-btn" onClick={onTriggerUploadSource} title="Upload Source Video">
            <FolderPlus size={12} />
            Import Source
          </button>

          <button
            className="pr-btn"
            onClick={onTriggerUploadReference}
            title="Upload Reference Video to Clone Editing Style"
            style={{ borderColor: '#6d4aff', color: '#d8ceff' }}
          >
            <Wand2 size={12} color="#a78bfa" />
            Clone Reference Style
          </button>

          <button
            className="pr-btn"
            onClick={onAutoGenerateClips}
            title="Re-Run 9:16 Clip Generation with Active Scheme"
          >
            <Sparkles size={12} color="#46a3ff" />
            Auto-Cut 9:16
          </button>

          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              background: '#151515',
              border: '1px solid #343434',
              borderRadius: 4,
              padding: '2px 4px',
              gap: 3,
            }}
          >
            <Cpu size={12} color="#46a3ff" style={{ marginLeft: 3 }} />
            <span style={{ fontSize: 10.5, color: '#999', marginRight: 2 }}>AI:</span>
            {(['gemini', 'claude', 'openai'] as AIProviderId[]).map((prov) => {
              const active = aiSettings.activeProvider === prov;
              const label =
                prov === 'gemini' ? 'Gemini ★' : prov === 'claude' ? 'Claude' : 'OpenAI';
              return (
                <button
                  key={prov}
                  onClick={() => onChangeProvider(prov)}
                  style={{
                    border: 'none',
                    borderRadius: 3,
                    padding: '2px 7px',
                    fontSize: 10.5,
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                    background: active ? '#2d8ceb' : 'transparent',
                    color: active ? '#fff' : '#a0a0a0',
                  }}
                  title={`Switch AI Engine to ${label} (${aiSettings.models[prov]})`}
                >
                  {label}
                </button>
              );
            })}
            <button
              className="pr-icon-btn"
              style={{ width: 20, height: 18 }}
              onClick={onOpenAISettings}
              title="Configure Gemini / Claude / OpenAI Models & Vercel Keys"
            >
              <Settings size={11} />
            </button>
          </div>

          <button
            className="pr-btn pr-btn-primary"
            onClick={onExportActiveClip}
            disabled={isExporting}
            title="Render & Download 9:16 Social Clip (.webm)"
          >
            {isExporting ? (
              <>
                <Film size={12} />
                Rendering {exportProgress}%
              </>
            ) : (
              <>
                <Download size={12} />
                Export 9:16
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
};
