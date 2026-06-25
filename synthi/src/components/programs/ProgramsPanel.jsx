'use client';

import { useCallback, useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { toast } from 'sonner';
import {
  fetchProgramSessions,
  restartProgramSession,
  stopProgramSession,
  deleteProgramSession,
  fetchInstalledPrograms,
  installWorkspaceProgram,
  launchInstalledProgram,
  publishWorkspaceProgram,
  fetchMarketplace,
  installPublishedProgram,
  scaffoldProgram,
  fetchDetectedProgram,
  launchDetectedProgram,
} from './programsClient';
import { SCAFFOLDABLE_PACKAGE_IDS } from '@/lib/programs/scaffoldTemplates';
import { isActiveProgramSession, isTerminalRuntimeType } from './programSessionSections';
import {
  activateTabAction,
  openTab,
  openFloatingPanel,
  bringFloatToFrontAction,
  selectNodes,
  selectTabs,
  selectFloating,
  setFocusedTabGroup,
} from '@/components/docking-wm/state/layout-slice';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';
import { setShowTerminal } from '@/redux/uiSlice';
import { PROGRAM_STYLE } from './programTokens';
import LibraryView from './library/LibraryView';
import StoreView from './store/StoreView';
import ConfirmDialog from './ConfirmDialog';

function sessionLabel(session) {
  if (!session?.id) {
    return 'Program session';
  }
  return `Session ${String(session.id).slice(0, 8)}`;
}

function findProgramSessionTab(nodes, tabs, programSessionId) {
  for (const [groupId, node] of Object.entries(nodes || {})) {
    if (node?.type !== 'tabgroup') continue;
    for (const tabId of node.tabs || []) {
      const tab = tabs?.[tabId];
      if (tab?.panelType === IDE_PANEL.PROGRAM_SESSION && tab?.data?.programSessionId === programSessionId) {
        return { groupId, tabId, tab };
      }
    }
  }
  return null;
}

function findProgramSessionFloat(floating, tabs, programSessionId) {
  for (const fw of Object.values(floating || {})) {
    const tab = tabs?.[fw.tabId];
    if (tab?.panelType === IDE_PANEL.PROGRAM_SESSION && tab?.data?.programSessionId === programSessionId) {
      return fw;
    }
  }
  return null;
}

function findEditorGroupId(nodes, tabs) {
  for (const [groupId, node] of Object.entries(nodes || {})) {
    if (node?.type !== 'tabgroup') continue;
    if ((node.tabs || []).some((tabId) => tabs?.[tabId]?.panelType === IDE_PANEL.EDITOR)) {
      return groupId;
    }
  }
  return Object.entries(nodes || {}).find(([, node]) => node?.type === 'tabgroup')?.[0] || null;
}

export default function ProgramsPanel() {
  const dispatch = useDispatch();
  const workspaceSlug = useSelector((state) => state.workspace?.slug || null);
  const workspaceRole = useSelector((state) => state.workspace?.role || null);
  const nodes = useSelector(selectNodes);
  const tabs = useSelector(selectTabs);
  const floating = useSelector(selectFloating);

  const [view, setView] = useState('library');
  const [sessions, setSessions] = useState([]);
  const [installs, setInstalls] = useState([]);
  const [marketplace, setMarketplace] = useState([]);
  const [marketQuery, setMarketQuery] = useState('');
  const [detected, setDetected] = useState(null);
  const [loading, setLoading] = useState(true);
  const [consent, setConsent] = useState(null); // { requested, published? }
  const [busy, setBusy] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);

  // Members get a read-only view; owner/admin (or unknown role — the API still
  // enforces) can launch / install. 'member' is the only role denied here.
  const canManage = workspaceRole !== 'member';

  const load = useCallback(async () => {
    if (!workspaceSlug) {
      setSessions([]);
      setInstalls([]);
      setMarketplace([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const [nextSessions, nextInstalls, nextMarket, nextDetected] = await Promise.all([
        fetchProgramSessions(workspaceSlug),
        fetchInstalledPrograms(workspaceSlug).catch(() => []),
        fetchMarketplace(workspaceSlug, marketQuery).catch(() => []),
        fetchDetectedProgram(workspaceSlug).catch(() => null),
      ]);
      setSessions(nextSessions);
      setInstalls(nextInstalls);
      setMarketplace(Array.isArray(nextMarket) ? nextMarket : []);
      setDetected(nextDetected || null);
    } catch (error) {
      toast.error(error.message || 'Failed to load programs');
    } finally {
      setLoading(false);
    }
  }, [workspaceSlug, marketQuery]);

  useEffect(() => {
    load();
  }, [load]);

  const openProgramSession = useCallback((session, { label = null, command = null } = {}) => {
    if (!session?.id) return;

    // CLI/TUI programs run in the REAL integrated terminal (a terminal tab bound
    // to the session PTY), not a ProgramSessionPanel.
    if (isTerminalRuntimeType(session.runtimeType)) {
      dispatch(setShowTerminal(true));
      window.dispatchEvent(new CustomEvent('terminal-session-open', {
        detail: { sessionId: session.id, command: command || null, label: label || sessionLabel(session) },
      }));
      return;
    }

    const existing = findProgramSessionTab(nodes, tabs, session.id);
    if (existing) {
      dispatch(setFocusedTabGroup(existing.groupId));
      dispatch(activateTabAction({ tabId: existing.tabId }));
      return;
    }

    const existingFloat = findProgramSessionFloat(floating, tabs, session.id);
    if (existingFloat) {
      dispatch(bringFloatToFrontAction({ floatId: existingFloat.id }));
      return;
    }

    const data = {
      programSessionId: session.id,
      workspaceSlug,
      title: sessionLabel(session),
    };

    // GUI dev-tool sessions pop up as a FLOATING, movable/dockable window.
    if (session.webGui) {
      dispatch(openFloatingPanel({
        panelType: IDE_PANEL.PROGRAM_SESSION,
        title: sessionLabel(session),
        data,
      }));
      return;
    }

    const targetTabGroupId = findEditorGroupId(nodes, tabs);
    if (!targetTabGroupId) return;

    dispatch(openTab({
      panelType: IDE_PANEL.PROGRAM_SESSION,
      title: sessionLabel(session),
      targetTabGroupId,
      data,
    }));
    dispatch(setFocusedTabGroup(targetTabGroupId));
  }, [dispatch, nodes, tabs, floating, workspaceSlug]);

  const handleStop = useCallback(async (session) => {
    if (!workspaceSlug || !session?.id) return;
    try {
      await stopProgramSession(workspaceSlug, session.id);
      toast.success(`${sessionLabel(session)} stopped`);
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to stop program');
    }
  }, [load, workspaceSlug]);

  const handleRestart = useCallback(async (session) => {
    if (!workspaceSlug || !session?.id) return;
    try {
      await restartProgramSession(workspaceSlug, session.id);
      toast.success(`${sessionLabel(session)} restarted`);
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to restart program');
    }
  }, [load, workspaceSlug]);

  const doRemove = useCallback(async (session) => {
    if (!workspaceSlug || !session?.id) return;
    setRemoveTarget(null);
    try {
      await deleteProgramSession(workspaceSlug, session.id);
      toast.success(`${sessionLabel(session)} removed`);
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to remove session');
    }
  }, [load, workspaceSlug]);

  // A running session needs confirmation (removing it stops + deletes it); an
  // idle one (stopped/crashed) is just a record, so drop it straight away.
  const handleRemove = useCallback((session) => {
    if (!session?.id) return;
    if (isActiveProgramSession(session)) {
      setRemoveTarget(session);
    } else {
      doRemove(session);
    }
  }, [doRemove]);

  const handleLaunchInstall = useCallback(async (install) => {
    if (!workspaceSlug || !install?.id) return;
    // One instance per program: if it already has a live session, focus that one
    // instead of spawning another. (sessions are reconciled, so a dead/zombie
    // session won't match and the program can still be relaunched.)
    const existing = sessions.find((s) => s.installId === install.id && isActiveProgramSession(s));
    if (existing) {
      openProgramSession(existing, { label: install.packageId });
      return;
    }
    try {
      const result = await launchInstalledProgram(workspaceSlug, install.id);
      toast.success('Program launched');
      if (result?.session) {
        openProgramSession(result.session, { label: install.packageId });
      }
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to launch program');
    }
  }, [sessions, load, openProgramSession, workspaceSlug]);

  const handleScaffold = useCallback(async (install) => {
    if (!workspaceSlug || !install?.id) return;
    const name = install.packageId?.split('/').pop() || 'starter';
    if (!window.confirm(`Scaffold a "${name}" starter into this workspace? Existing files are skipped.`)) return;
    try {
      const result = await scaffoldProgram(workspaceSlug, install.packageId);
      toast.success(`Scaffolded ${result?.written?.length || 0} file(s)` + (result?.skipped?.length ? `, skipped ${result.skipped.length}` : ''));
      await handleLaunchInstall(install);
    } catch (error) {
      toast.error(error.body?.message || error.message || 'Failed to scaffold');
    }
  }, [handleLaunchInstall, workspaceSlug]);

  const handleLaunchDetected = useCallback(async () => {
    if (!workspaceSlug) return;
    try {
      const result = await launchDetectedProgram(workspaceSlug);
      toast.success('Detected program launched');
      if (result?.session) {
        openProgramSession(result.session);
      }
      await load();
    } catch (error) {
      toast.error(error.message || 'Failed to launch detected program');
    }
  }, [load, openProgramSession, workspaceSlug]);

  const handlePublish = useCallback(async () => {
    if (!workspaceSlug) return;
    try {
      const { program } = await publishWorkspaceProgram(workspaceSlug);
      toast.success(`Published ${program?.packageId || 'program'}`);
      await load();
    } catch (error) {
      if (error?.status === 422) toast.error(error.body?.message || 'Invalid manifest');
      else if (error?.status === 404) toast.error('No vectant.programs.json or devcontainer.json found in this workspace.');
      else toast.error(error.body?.message || error.message || 'Failed to publish');
    }
  }, [load, workspaceSlug]);

  const handleInstallManifest = useCallback(async (grantScopes) => {
    if (!workspaceSlug) return;
    setBusy(true);
    try {
      await installWorkspaceProgram(workspaceSlug, grantScopes ? { grantScopes } : {});
      toast.success('Program installed');
      setConsent(null);
      await load();
    } catch (error) {
      if (error?.status === 409) {
        setConsent({ requested: error.body?.requested || [] });
      } else if (error?.status === 404) {
        toast.error('No vectant.programs.json or devcontainer.json found in this workspace.');
      } else if (error?.status === 422) {
        toast.error(error.body?.message || 'Invalid manifest');
      } else {
        toast.error(error.message || 'Failed to install program');
      }
    } finally {
      setBusy(false);
    }
  }, [load, workspaceSlug]);

  const handleInstallPublished = useCallback(async (item, grantScopes) => {
    if (!workspaceSlug || !item?.packageId) return;
    setBusy(true);
    try {
      await installPublishedProgram(workspaceSlug, item.packageId, item.latestVersion, grantScopes);
      toast.success(`Installed ${item.packageId}`);
      setConsent(null);
      await load();
    } catch (error) {
      if (error?.status === 409) setConsent({ requested: error.body?.requested || [], published: item });
      else toast.error(error.body?.message || error.message || 'Failed to install');
    } finally {
      setBusy(false);
    }
  }, [load, workspaceSlug]);

  const onApprove = useCallback((_item, scopes) => (
    consent?.published ? handleInstallPublished(consent.published, scopes) : handleInstallManifest(scopes)
  ), [consent, handleInstallManifest, handleInstallPublished]);

  // Synthetic detail subject for a manifest-install consent (no published item).
  const consentItem = consent
    ? (consent.published || { packageId: '__manifest__', displayName: 'Workspace program', latestVersion: '', verified: false })
    : null;

  return (
    <div className="flex flex-col h-full min-h-0" style={{ ...PROGRAM_STYLE.panelShell, borderRadius: '0' }}>
      {view === 'library' ? (
        <LibraryView
          canManage={canManage}
          slug={workspaceSlug}
          sessions={sessions}
          installs={installs}
          detected={detected}
          loading={loading}
          scaffoldableIds={SCAFFOLDABLE_PACKAGE_IDS}
          onOpenStore={() => setView('store')}
          onRefresh={load}
          onOpenSession={openProgramSession}
          onStop={handleStop}
          onRestart={handleRestart}
          onRemove={handleRemove}
          onLaunchInstall={handleLaunchInstall}
          onScaffold={handleScaffold}
          onLaunchDetected={handleLaunchDetected}
        />
      ) : (
        <StoreView
          canManage={canManage}
          marketplace={marketplace}
          query={marketQuery}
          onQueryChange={setMarketQuery}
          onBack={() => { setView('library'); setConsent(null); }}
          onInstallManifest={() => handleInstallManifest()}
          onPublish={handlePublish}
          onInstallPublished={(item) => handleInstallPublished(item)}
          requestedScopes={consent?.requested || []}
          consentItem={consentItem}
          busy={busy}
          onApprove={onApprove}
        />
      )}

      {removeTarget ? (
        <ConfirmDialog
          title="Remove this running program?"
          message={`${sessionLabel(removeTarget)} is still running. Removing it stops the session and deletes it — this can't be undone.`}
          confirmLabel="Stop & remove"
          cancelLabel="Cancel"
          onConfirm={() => doRemove(removeTarget)}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}
    </div>
  );
}
