import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Profile } from '@/core/types';
import type { MergeMode } from '@/core/sync';
import { useStore } from '@/ui/store';
import { useTheme } from '@/ui/theme';
import {
  Switch,
  StatusBar,
  HeaderTable,
  FilterEditor,
  Card,
  ImportPreview,
  SyncPanel,
  SyncMergeDialog,
  SyncDefaultNotice,
} from '@/ui/components';
import { newProfile } from '@/ui/factory';
import { ProjectFooter } from '@/ui/ProjectFooter';
import { newId } from '@/core/id';
import { DEFAULT_BADGE_COLOR } from '@/core/constants';
import { exportProfiles, importProfiles, ImportError } from '@/core/importexport';
import {
  requestSync,
  requestSyncClear,
  requestSyncStatus,
  type SyncStatus,
} from '@/messaging/messages';
import {
  summarizeImport,
  profilesHaveSensitiveValues,
  type ImportSummary,
} from '@/core/import-analysis';

interface PendingImport {
  profiles: Profile[];
  warnings: string[];
  summary: ImportSummary;
}

/**
 * How long before we nag about a stale backup. Sync covers losing a device, but
 * NOT the extension changing id (a store migration gives a fresh, empty sync
 * namespace) — an exported file is the only thing that survives that.
 */
const BACKUP_STALE_MS = 30 * 24 * 60 * 60 * 1000;

export function Options() {
  const { schema, status, loading, loadError, setSchema, patchSettings } = useStore();
  useTheme(schema?.settings.theme);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [mergePrompt, setMergePrompt] = useState<{ local: number; remote: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const fileInput = useRef<HTMLInputElement>(null);

  // Read-only: opening the page must not write to either storage area.
  useEffect(() => {
    void requestSyncStatus()
      .then((s) => {
        setSync(s);
        setNow(Date.now());
      })
      .catch(() => {
        /* worker may be starting; the panel refreshes on the next action */
      });
  }, []);

  const profiles = schema?.profiles ?? [];
  const selected = useMemo(
    () => profiles.find((p) => p.id === selectedId) ?? profiles[0] ?? null,
    [profiles, selectedId],
  );

  if (loading) return <div class="options">Loading…</div>;
  if (!schema)
    return (
      <div class="options" role="alert">
        Could not load profiles: {loadError}{' '}
        <button onClick={() => location.reload()}>Retry</button>
      </div>
    );

  const updateProfile = (next: Profile) =>
    setSchema({ ...schema, profiles: profiles.map((p) => (p.id === next.id ? next : p)) });

  const addProfile = () => {
    const p = newProfile(`Profile ${profiles.length + 1}`);
    setSchema({ ...schema, profiles: [...profiles, p] });
    setSelectedId(p.id);
  };

  const cloneProfile = (p: Profile) => {
    const copy: Profile = {
      ...p,
      id: newId(),
      name: `${p.name} (copy)`,
      headers: p.headers.map((h) => ({ ...h, id: newId() })),
    };
    setSchema({ ...schema, profiles: [...profiles, copy] });
    setSelectedId(copy.id);
  };

  const deleteProfile = (id: string) => {
    const target = profiles.find((p) => p.id === id);
    if (target && !confirm(`Delete profile “${target.name}”? This cannot be undone.`)) return;
    const remaining = profiles.filter((p) => p.id !== id);
    setSchema({
      ...schema,
      profiles: remaining,
      settings:
        schema.settings.activeProfileId === id
          ? { ...schema.settings, activeProfileId: remaining[0]?.id }
          : schema.settings,
    });
    if (selectedId === id) setSelectedId(remaining[0]?.id ?? null);
  };

  const doExport = () => {
    // Header values may be secrets (tokens/cookies) and are exported in plaintext
    // (finding L-02); confirm before writing a file that contains them.
    if (
      profilesHaveSensitiveValues(profiles) &&
      !confirm(
        'This export will include header values — such as Authorization tokens or cookies — ' +
          'in plaintext. Anyone you share the file with can read them.\n\nExport anyway?',
      )
    ) {
      return;
    }
    const blob = new Blob([exportProfiles(profiles)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'httpatch-profiles.json';
    a.click();
    URL.revokeObjectURL(url);
    // Records the backup so the staleness prompt stands down. Uses a plain
    // Blob + anchor download, so no `downloads` permission is needed.
    void patchSettings({ lastBackupAt: Date.now() });
  };

  // --- sync ---------------------------------------------------------------
  // The worker owns replication; the UI only asks for a cycle and reads back
  // status. Every settings write is awaited before messaging, because the worker
  // re-reads storage to decide whether sync is even enabled.

  const runSyncCycle = async (mergeMode?: MergeMode) => {
    setSyncBusy(true);
    try {
      const next = await requestSync(mergeMode);
      setSync(next);
      setNow(Date.now());
      if (next.lastError) setNotice(`Sync problem: ${next.lastError}`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Sync failed.');
    } finally {
      setSyncBusy(false);
    }
  };

  const refreshSync = async () => {
    try {
      setSync(await requestSyncStatus());
      setNow(Date.now());
    } catch {
      /* best-effort */
    }
  };

  const toggleSync = async (enabled: boolean) => {
    // Working the toggle at all is an explicit choice, so the default-on notice
    // has nothing left to tell this user.
    if (!enabled) {
      // Disabling only stops this device. The synced copy is removed separately
      // and explicitly, so "stop syncing" can never surprise other devices.
      if (!(await patchSettings({ syncEnabled: false, syncNoticeDismissed: true }))) return;
      await refreshSync();
      return;
    }

    const current = await requestSyncStatus().catch(() => null);
    if (current && !current.available) {
      setSync(current);
      setNotice(
        'This browser has no usable sync area. Sign in to the browser, or check whether sync is disabled by policy.',
      );
      return;
    }
    // Both sides already hold profiles and this device has never synced — ask
    // before combining rather than guessing.
    if (current && current.firstRun && current.remoteProfileCount > 0 && profiles.length > 0) {
      setMergePrompt({ local: profiles.length, remote: current.remoteProfileCount });
      return;
    }
    if (!(await patchSettings({ syncEnabled: true, syncNoticeDismissed: true }))) return;
    await runSyncCycle('merge');
  };

  const chooseMerge = async (mode: MergeMode) => {
    setMergePrompt(null);
    if (!(await patchSettings({ syncEnabled: true, syncNoticeDismissed: true }))) return;
    await runSyncCycle(mode);
  };

  const clearRemote = async () => {
    if (
      !confirm(
        'Delete the synced copy of your profiles from this browser account?\n\n' +
          'The profiles on this device are kept. Other devices that are still syncing will ' +
          'restore their own copy the next time they sync.',
      )
    ) {
      return;
    }
    setSyncBusy(true);
    try {
      setSync(await requestSyncClear());
      setNow(Date.now());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not remove the synced copy.');
    } finally {
      setSyncBusy(false);
    }
  };

  // Only for people who never chose this: sync is on, actually working, and the
  // user has neither dismissed the notice nor touched the toggle themselves.
  const showSyncNotice =
    sync?.enabled === true && sync.available && !schema.settings.syncNoticeDismissed;

  const backupStale =
    profiles.length > 0 &&
    (!schema.settings.lastBackupAt || now - schema.settings.lastBackupAt > BACKUP_STALE_MS);

  // Parse and validate the file, then stage it for the confirmation preview
  // (finding L-01). Nothing is committed to storage until confirmImport().
  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const { profiles: imported, warnings } = importProfiles(text);
      setPending({ profiles: imported, warnings, summary: summarizeImport(imported) });
    } catch (e) {
      setNotice(e instanceof ImportError ? e.message : 'Import failed.');
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const confirmImport = () => {
    if (!pending) return;
    setSchema({ ...schema, profiles: [...profiles, ...pending.profiles] });
    setNotice(
      `Imported ${pending.profiles.length} profile(s).` +
        (pending.warnings.length ? ` ${pending.warnings.length} warning(s).` : ''),
    );
    setPending(null);
  };

  return (
    <div class="options">
      {pending && (
        <ImportPreview
          summary={pending.summary}
          warnings={pending.warnings}
          onConfirm={confirmImport}
          onCancel={() => setPending(null)}
        />
      )}
      {mergePrompt && (
        <SyncMergeDialog
          localCount={mergePrompt.local}
          remoteCount={mergePrompt.remote}
          onChoose={(mode) => void chooseMerge(mode)}
          onCancel={() => setMergePrompt(null)}
        />
      )}
      <aside class="sidebar">
        <div class="sidebar-primary">
          <div class="sidebar-brand">
            <span class="brand-mark">H</span>
            <span class="brand-copy">
              <h1>HTTPatch</h1>
              <small>Header workspace</small>
            </span>
          </div>
          <button class="primary new-profile-button" onClick={addProfile}>
            + New profile
          </button>
          <ul class="plist">
            {profiles.map((p) => (
              <li
                key={p.id}
                class={selected?.id === p.id ? 'active' : ''}
                onClick={() => setSelectedId(p.id)}
              >
                <span class="dot" style={`background:${p.color ?? DEFAULT_BADGE_COLOR}`} />
                <span class="pname" style={p.enabled ? '' : 'opacity:0.5'}>
                  {p.name}
                </span>
                {p.tabOnly && <span class="tab-indicator">Tab</span>}
                <Switch checked={p.enabled} onChange={(v) => updateProfile({ ...p, enabled: v })} />
              </li>
            ))}
          </ul>
        </div>
      </aside>

      <main class="main">
        <div class="main-intro">
          <h2>Profile settings</h2>
          <p>Build header rules and choose where they apply.</p>
        </div>
        {showSyncNotice && (
          <SyncDefaultNotice
            onDismiss={() => void patchSettings({ syncNoticeDismissed: true })}
            onTurnOff={() => void toggleSync(false)}
          />
        )}

        {notice && (
          <div class="alert warn" onClick={() => setNotice(null)}>
            {notice} <span class="muted">(click to dismiss)</span>
          </div>
        )}

        {!selected ? (
          <div class="card">
            <h2>No profile selected</h2>
            <p class="muted">Create a profile to start modifying headers.</p>
          </div>
        ) : (
          <>
            {selected.tabOnly && (
              <div class="alert warn">
                This profile runs only in its assigned tab on this device. Open the popup on a page
                to assign or change that tab.
              </div>
            )}
            <div class="toolbar">
              <input
                type="text"
                value={selected.name}
                style="max-width:280px;font-weight:600"
                onInput={(e) =>
                  updateProfile({ ...selected, name: (e.target as HTMLInputElement).value })
                }
              />
              <label class="inline muted" title="Badge color">
                Color
                <input
                  type="color"
                  value={selected.color ?? DEFAULT_BADGE_COLOR}
                  onInput={(e) =>
                    updateProfile({ ...selected, color: (e.target as HTMLInputElement).value })
                  }
                />
              </label>
              <input
                type="text"
                placeholder="Badge"
                maxLength={4}
                value={selected.badgeText ?? ''}
                style="max-width:70px"
                onInput={(e) =>
                  updateProfile({ ...selected, badgeText: (e.target as HTMLInputElement).value })
                }
              />
              <div class="spacer" />
              <button class="ghost" onClick={() => cloneProfile(selected)}>
                Clone
              </button>
              <button class="ghost danger" onClick={() => deleteProfile(selected.id)}>
                Delete
              </button>
            </div>

            <Card>
              <div class="section-label">Headers</div>
              <HeaderTable
                headers={selected.headers}
                onChange={(headers) => updateProfile({ ...selected, headers })}
              />
            </Card>

            <div style="height:16px" />

            <Card>
              <FilterEditor
                filters={selected.filters}
                onChange={(filters) => updateProfile({ ...selected, filters })}
              />
            </Card>
          </>
        )}

        <StatusBar status={status} />
      </main>
      <aside class="sidebar-secondary">
        <div class="sidebar-backup">
          <div class="section-label">Backup</div>
          <div class="inline">
            <button class="ghost" onClick={doExport} disabled={profiles.length === 0}>
              Export
            </button>
            <button class="ghost" onClick={() => fileInput.current?.click()}>
              Import
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="application/json,.json"
              style="display:none"
              onChange={(e) => {
                const f = (e.target as HTMLInputElement).files?.[0];
                if (f) void doImport(f);
              }}
            />
          </div>
          {backupStale && (
            <div class="alert warn" style="font-size:11px;margin-top:6px">
              {schema.settings.lastBackupAt
                ? 'Your last backup is over a month old.'
                : 'You have never exported a backup.'}{' '}
              A backup file is the only copy that survives the extension being reinstalled under a
              new id.
            </div>
          )}
          <p class="muted" style="font-size:11px;margin:6px 0 0">
            Exports are plain JSON and include header values — tokens, cookies, and other secrets
            are stored unencrypted. Share exported files with care.
          </p>
        </div>

        <SyncPanel
          status={sync}
          busy={syncBusy}
          now={now}
          onToggle={(v) => void toggleSync(v)}
          onSyncNow={() => void runSyncCycle()}
          onClearRemote={() => void clearRemote()}
        />

        <div style="margin-top:16px">
          <div class="section-label">Settings</div>
          <label class="inline" style="margin-bottom:8px">
            <Switch
              checked={!schema.settings.paused}
              onChange={(v) => patchSettings({ paused: !v })}
            />
            <span>{schema.settings.paused ? 'Paused' : 'Active'}</span>
          </label>
          <div class="field">
            <label>Theme</label>
            <select
              value={schema.settings.theme}
              onChange={(e) =>
                patchSettings({ theme: (e.target as HTMLSelectElement).value as never })
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">System</option>
            </select>
          </div>
        </div>
        <ProjectFooter />
      </aside>
    </div>
  );
}
