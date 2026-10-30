import React from 'react';
import {
  ArrowRightToLine,
  Crop,
  Hand,
  MousePointer,
  MoveHorizontal,
  Repeat,
  Scissors,
  Type,
} from 'lucide-react';
import { NLEToolId } from '../types/editor';

interface ToolStripProps {
  activeTool: NLEToolId;
  onSelectTool: (tool: NLEToolId) => void;
}

const TOOLS: Array<{ id: NLEToolId; label: string; shortcut: string; icon: React.ReactNode }> = [
  { id: 'select', label: 'Selection Tool', shortcut: 'V', icon: <MousePointer size={13} /> },
  {
    id: 'track-select',
    label: 'Track Select Forward Tool',
    shortcut: 'A',
    icon: <ArrowRightToLine size={13} />,
  },
  { id: 'ripple', label: 'Ripple Edit Tool', shortcut: 'B', icon: <MoveHorizontal size={13} /> },
  { id: 'razor', label: 'Razor Split Tool', shortcut: 'C', icon: <Scissors size={13} /> },
  { id: 'slip', label: 'Slip Tool', shortcut: 'Y', icon: <Repeat size={13} /> },
  { id: 'reframe', label: '9:16 Subject Reframe Tool', shortcut: 'R', icon: <Crop size={13} /> },
  { id: 'hand', label: 'Hand Tool', shortcut: 'H', icon: <Hand size={13} /> },
  { id: 'text', label: 'Type Caption Tool', shortcut: 'T', icon: <Type size={13} /> },
];

export const ToolStrip: React.FC<ToolStripProps> = ({ activeTool, onSelectTool }) => {
  return (
    <aside className="pr-tool-strip">
      {TOOLS.map((t) => (
        <button
          key={t.id}
          className={`pr-tool-btn ${activeTool === t.id ? 'active' : ''}`}
          onClick={() => onSelectTool(t.id)}
          title={`${t.label} (${t.shortcut})`}
        >
          {t.icon}
        </button>
      ))}
    </aside>
  );
};
