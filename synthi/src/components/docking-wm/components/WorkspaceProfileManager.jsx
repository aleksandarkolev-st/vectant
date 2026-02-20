/**
 * @fileoverview WorkspaceProfileManager — UI for saving, loading, and managing workspace profiles.
 */

'use client';

import React, { useState, useCallback, useEffect } from 'react';
import { useDockingContext } from './DockingProvider';

/**
 * Workspace Profile Manager panel.
 * Shows a list of saved profiles with save/load/delete actions.
 *
 * @param {Object} props
 * @param {boolean} [props.isOpen]
 * @param {function} [props.onClose]
 */
export function WorkspaceProfileManager({ isOpen, onClose }) {
  const { profiles } = useDockingContext();
  const [allProfiles, setAllProfiles] = useState([]);
  const [newName, setNewName] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [feedback, setFeedback] = useState(null);

  // Load profiles
  const refreshProfiles = useCallback(() => {
    setAllProfiles(profiles.getAll());
  }, [profiles]);

  useEffect(() => {
    if (isOpen) refreshProfiles();
  }, [isOpen, refreshProfiles]);

  const handleSave = useCallback(() => {
    if (!newName.trim()) return;
    const id = profiles.save(newName.trim(), newDescription.trim());
    setNewName('');
    setNewDescription('');
    setShowSaveForm(false);
    setFeedback({ type: 'success', message: `Profile "${newName}" saved` });
    refreshProfiles();
    setTimeout(() => setFeedback(null), 2000);
  }, [newName, newDescription, profiles, refreshProfiles]);

  const handleLoad = useCallback(
    (profileId, profileName) => {
      const result = profiles.load(profileId);
      if (result) {
        setFeedback({ type: 'success', message: `Loaded "${profileName}"` });
      } else {
        setFeedback({ type: 'error', message: 'Failed to load profile' });
      }
      setTimeout(() => setFeedback(null), 2000);
    },
    [profiles]
  );

  const handleDelete = useCallback(
    (profileId, profileName) => {
      profiles.remove(profileId);
      setFeedback({ type: 'success', message: `Deleted "${profileName}"` });
      refreshProfiles();
      setTimeout(() => setFeedback(null), 2000);
    },
    [profiles, refreshProfiles]
  );

  const handleReset = useCallback(() => {
    profiles.resetToDefault();
    setFeedback({ type: 'success', message: 'Reset to default layout' });
    setTimeout(() => setFeedback(null), 2000);
  }, [profiles]);

  if (!isOpen) return null;

  return (
    <div
      className="dock-profile-manager"
      style={{
        position: 'absolute',
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)',
        width: '420px',
        maxHeight: '500px',
        backgroundColor: '#252526',
        border: '1px solid #3c3c3c',
        borderRadius: '8px',
        boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
        zIndex: 200,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        color: '#d4d4d4',
        fontSize: '13px',
        fontFamily: 'var(--dock-font)',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #3c3c3c',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: '14px' }}>
          Workspace Profiles
        </span>
        <button
          onClick={onClose}
          style={{
            border: 'none',
            background: 'none',
            color: '#969696',
            cursor: 'pointer',
            padding: '4px',
            fontSize: '16px',
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>

      {/* Feedback toast */}
      {feedback && (
        <div
          style={{
            padding: '8px 16px',
            backgroundColor: feedback.type === 'success' ? '#1b3a1b' : '#3a1b1b',
            color: feedback.type === 'success' ? '#4ec94e' : '#e94e4e',
            fontSize: '12px',
          }}
        >
          {feedback.message}
        </div>
      )}

      {/* Profile list */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0',
        }}
      >
        {allProfiles.length === 0 && (
          <div
            style={{
              padding: '20px 16px',
              textAlign: 'center',
              color: '#969696',
              opacity: 0.7,
            }}
          >
            No saved profiles yet
          </div>
        )}

        {allProfiles.map((profile) => (
          <div
            key={profile.id}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{profile.name}</div>
              {profile.description && (
                <div style={{ fontSize: '11px', color: '#969696', marginTop: '2px' }}>
                  {profile.description}
                </div>
              )}
              <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
                {new Date(profile.updatedAt).toLocaleDateString()}
              </div>
            </div>
            <button
              onClick={() => handleLoad(profile.id, profile.name)}
              style={{
                padding: '4px 10px',
                border: '1px solid #007acc',
                borderRadius: '4px',
                backgroundColor: 'transparent',
                color: '#007acc',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              Load
            </button>
            <button
              onClick={() => handleDelete(profile.id, profile.name)}
              style={{
                padding: '4px 8px',
                border: '1px solid #444',
                borderRadius: '4px',
                backgroundColor: 'transparent',
                color: '#969696',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Save form */}
      {showSaveForm ? (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid #3c3c3c',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Profile name"
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            style={{
              padding: '6px 10px',
              backgroundColor: '#1e1e1e',
              border: '1px solid #3c3c3c',
              borderRadius: '4px',
              color: '#d4d4d4',
              fontSize: '13px',
              outline: 'none',
            }}
          />
          <input
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Description (optional)"
            style={{
              padding: '6px 10px',
              backgroundColor: '#1e1e1e',
              border: '1px solid #3c3c3c',
              borderRadius: '4px',
              color: '#d4d4d4',
              fontSize: '13px',
              outline: 'none',
            }}
          />
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
            <button
              onClick={() => setShowSaveForm(false)}
              style={{
                padding: '6px 14px',
                border: '1px solid #444',
                borderRadius: '4px',
                backgroundColor: 'transparent',
                color: '#969696',
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={!newName.trim()}
              style={{
                padding: '6px 14px',
                border: 'none',
                borderRadius: '4px',
                backgroundColor: '#007acc',
                color: '#fff',
                cursor: newName.trim() ? 'pointer' : 'not-allowed',
                fontSize: '12px',
                opacity: newName.trim() ? 1 : 0.5,
              }}
            >
              Save Profile
            </button>
          </div>
        </div>
      ) : (
        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid #3c3c3c',
            display: 'flex',
            gap: '8px',
          }}
        >
          <button
            onClick={() => setShowSaveForm(true)}
            style={{
              flex: 1,
              padding: '8px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: '#007acc',
              color: '#fff',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Save Current Layout
          </button>
          <button
            onClick={handleReset}
            style={{
              padding: '8px 14px',
              border: '1px solid #444',
              borderRadius: '4px',
              backgroundColor: 'transparent',
              color: '#969696',
              cursor: 'pointer',
              fontSize: '12px',
            }}
          >
            Reset
          </button>
        </div>
      )}
    </div>
  );
}

export default WorkspaceProfileManager;
