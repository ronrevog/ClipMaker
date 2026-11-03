import React, { useEffect, useState } from 'react';
import {
  Cloud,
  Database,
  FolderOpen,
  HardDrive,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import {
  deleteStudioProject,
  listSavedStudioProjects,
  SavedProjectSummary,
} from '../services/projectStorage';

interface ProjectsModalProps {
  isOpen: boolean;
  currentProjectId: string;
  currentProjectName: string;
  hasActiveVideo: boolean;
  isSaving: boolean;
  onClose: () => void;
  onSaveCurrentProject: (customName: string, asNewProject: boolean) => Promise<void>;
  onRecallProject: (projectId: string) => Promise<void>;
}

export const ProjectsModal: React.FC<ProjectsModalProps> = ({
  isOpen,
  currentProjectId,
  currentProjectName,
  hasActiveVideo,
  isSaving,
  onClose,
  onSaveCurrentProject,
  onRecallProject,
}) => {
  const [projects, setProjects] = useState<SavedProjectSummary[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(false);
  const [recallingId, setRecallingId] = useState<string | null>(null);
  const [projectNameInput, setProjectNameInput] = useState(currentProjectName);

  useEffect(() => {
    setProjectNameInput(currentProjectName);
  }, [currentProjectName]);

  const refreshProjects = async () => {
    setIsLoadingList(true);
    try {
      const list = await listSavedStudioProjects();
      setProjects(list);
    } finally {
      setIsLoadingList(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      refreshProjects();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.76)',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '85vh',
          background: '#161922',
          border: '1px solid #2d8ceb',
          borderRadius: 10,
          boxShadow: '0 24px 64px rgba(0, 0, 0, 0.85)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '12px 16px',
            background: '#11131a',
            borderBottom: '1px solid #262b38',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 14 }}>
            <FolderOpen size={16} color="#60a5fa" />
            <span>Saved Projects Library (Save &amp; Recall)</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="btn"
              onClick={refreshProjects}
              disabled={isLoadingList}
              style={{ padding: '4px 8px', fontSize: 11 }}
              title="Refresh saved projects list"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
            <button type="button" className="btn" onClick={onClose} style={{ padding: '4px 8px' }}>
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Save Current Project Bar */}
        {hasActiveVideo && (
          <div
            style={{
              padding: '12px 16px',
              background: 'rgba(30, 41, 59, 0.55)',
              borderBottom: '1px solid #262b38',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              flexWrap: 'wrap',
            }}
          >
            <input
              type="text"
              value={projectNameInput}
              onChange={(e) => setProjectNameInput(e.target.value)}
              placeholder="Project Name..."
              style={{
                flex: 1,
                minWidth: 200,
                padding: '7px 10px',
                borderRadius: 6,
                border: '1px solid #334155',
                background: '#0f131a',
                color: '#fff',
                fontSize: 12.5,
              }}
            />
            <button
              type="button"
              className="btn btn-primary"
              disabled={isSaving}
              onClick={async () => {
                await onSaveCurrentProject(projectNameInput, false);
                await refreshProjects();
              }}
              style={{ padding: '7px 12px', fontSize: 12 }}
            >
              <Save size={13} />
              {isSaving ? 'Saving...' : 'Save Current Project'}
            </button>
            <button
              type="button"
              className="btn"
              disabled={isSaving}
              onClick={async () => {
                await onSaveCurrentProject(projectNameInput, true);
                await refreshProjects();
              }}
              style={{ padding: '7px 10px', fontSize: 12 }}
              title="Save a separate copy as a new project"
            >
              <Plus size={13} />
              Save As Copy
            </button>
          </div>
        )}

        {/* Saved Projects List */}
        <div
          style={{
            padding: 16,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            flex: 1,
          }}
        >
          {isLoadingList ? (
            <div style={{ padding: 28, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>
              Loading saved projects...
            </div>
          ) : projects.length === 0 ? (
            <div
              style={{
                padding: 32,
                textAlign: 'center',
                color: '#94a3b8',
                background: 'rgba(15, 23, 42, 0.5)',
                borderRadius: 8,
                border: '1px dashed #334155',
                fontSize: 13,
              }}
            >
              No saved projects yet. Upload a video and click <strong>Save Project</strong> (projects
              also auto-save as you edit!).
            </div>
          ) : (
            projects.map((proj) => {
              const isCurrent = proj.id === currentProjectId;
              const dateStr = proj.updatedAt
                ? new Date(proj.updatedAt).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })
                : '';

              return (
                <div
                  key={proj.id}
                  style={{
                    padding: '12px 14px',
                    borderRadius: 8,
                    background: isCurrent ? 'rgba(45, 140, 235, 0.14)' : '#1c202b',
                    border: isCurrent ? '1.5px solid #3b82f6' : '1px solid #2b3140',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 700, fontSize: 13.5, color: '#f8fafc' }}>
                        {proj.name}
                      </span>
                      {isCurrent && (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            background: 'rgba(59, 130, 246, 0.25)',
                            color: '#93c5fd',
                            padding: '1px 6px',
                            borderRadius: 4,
                          }}
                        >
                          ACTIVE
                        </span>
                      )}
                      <span
                        style={{
                          fontSize: 10,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 3,
                          background: 'rgba(16, 185, 129, 0.14)',
                          color: '#6ee7b7',
                          padding: '1px 6px',
                          borderRadius: 4,
                        }}
                      >
                        {proj.storageLocation === 'vercel-cloud' ? (
                          <>
                            <Cloud size={10} /> Vercel Synced
                          </>
                        ) : (
                          <>
                            <HardDrive size={10} /> Local Studio DB
                          </>
                        )}
                      </span>
                    </div>

                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        fontSize: 11.5,
                        color: '#94a3b8',
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        <Video size={12} color="#60a5fa" />
                        {proj.sourceFileName} ({Number(proj.sourceDuration || 0).toFixed(1)}s)
                      </span>
                      <span>• {proj.clipsCount || 0} Clips</span>
                      {proj.focusLocksCount > 0 && (
                        <span style={{ color: '#34d399', fontWeight: 600 }}>
                          • ◆ {proj.focusLocksCount} Focus Lock{proj.focusLocksCount === 1 ? '' : 's'}
                        </span>
                      )}
                      <span>• By {proj.ownerEmail || 'team@complex.com'}</span>
                      {dateStr && <span>• {dateStr}</span>}
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={recallingId === proj.id}
                      onClick={async () => {
                        setRecallingId(proj.id);
                        try {
                          await onRecallProject(proj.id);
                          onClose();
                        } finally {
                          setRecallingId(null);
                        }
                      }}
                      style={{ padding: '6px 12px', fontSize: 12 }}
                    >
                      <FolderOpen size={13} />
                      {recallingId === proj.id ? 'Loading...' : 'Recall Project'}
                    </button>

                    <button
                      type="button"
                      className="btn"
                      onClick={async () => {
                        await deleteStudioProject(proj.id);
                        await refreshProjects();
                      }}
                      style={{
                        padding: '6px 8px',
                        borderColor: 'rgba(239, 68, 68, 0.4)',
                        color: '#fca5a5',
                      }}
                      title="Delete saved project"
                    >
                      <Trash2 size={13} />
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
            padding: '10px 16px',
            background: '#11131a',
            borderTop: '1px solid #262b38',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: '#94a3b8',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Database size={12} color="#34d399" />
            Projects auto-save your video, timeline cuts, 9:16 clips, and Focus Lock Points.
          </span>
          <button type="button" className="btn" onClick={onClose} style={{ padding: '4px 10px', fontSize: 11.5 }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
