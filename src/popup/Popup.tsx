import { useEffect, useState } from 'preact/hooks';
import type { Profile } from '@/core/types';
import { siteScopeFromUrl } from '@/core/site-scope';
import { loadTabAssignments, type TabAssignments } from '@/core/tab-assignments';
import { getActiveTab } from '@/core/active-tab';
import { useStore } from '@/ui/store';
import { useTheme } from '@/ui/theme';
import { Switch, StatusBar, HeaderTable } from '@/ui/components';
import { ProjectFooter } from '@/ui/ProjectFooter';
import { newProfile } from '@/ui/factory';
import { DEFAULT_BADGE_COLOR } from '@/core/constants';
import { requestAssignTab } from '@/messaging/messages';

export function Popup() {
  const { schema, status, loading, loadError, setSchema, patchSettings } = useStore();
  const [currentSite, setCurrentSite] = useState<ReturnType<typeof siteScopeFromUrl>>(null);
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [tabAssignments, setTabAssignments] = useState<TabAssignments>({});
  const [tabScopeError, setTabScopeError] = useState<string | null>(null);
  useTheme(schema?.settings.theme);

  useEffect(() => {
    void getActiveTab()
      .then((tab) => {
        setCurrentSite(siteScopeFromUrl(tab.url));
        setCurrentTabId(tab.id);
      })
      .catch(() => setCurrentSite(null));
    void loadTabAssignments()
      .then(setTabAssignments)
      .catch(() => setTabAssignments({}));
  }, []);

  if (loading) {
    return <div class="popup">Loading…</div>;
  }
  if (!schema) {
    return (
      <div class="popup" role="alert">
        Could not load profiles: {loadError}{' '}
        <button onClick={() => location.reload()}>Retry</button>
      </div>
    );
  }

  const profiles = schema.profiles;
  const activeId = schema.settings.activeProfileId ?? profiles[0]?.id;
  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];
  const enabledHeaders = active?.headers.filter((h) => h.enabled && h.name.trim()).length ?? 0;
  const scopedToCurrentSite =
    !!currentSite &&
    active?.filters.urlFilters.filter((f) => f.mode === 'include').length === 1 &&
    active.filters.urlFilters.some(
      (f) => f.mode === 'include' && f.pattern === currentSite.filter.pattern,
    );
  const assignedTab = active ? tabAssignments[active.id] : undefined;

  const updateProfile = (next: Profile) =>
    setSchema({ ...schema, profiles: profiles.map((p) => (p.id === next.id ? next : p)) });

  const addProfile = () => {
    const p = newProfile(`Profile ${profiles.length + 1}`);
    setSchema({
      ...schema,
      profiles: [...profiles, p],
      settings: { ...schema.settings, activeProfileId: p.id },
    });
  };

  const openOptions = () => chrome.runtime.openOptionsPage();

  const assignTab = async (profile: Profile, tabId: number | null) => {
    setTabScopeError(null);
    try {
      const result = await requestAssignTab(profile.id, tabId);
      if (!result.applied) throw new Error(result.error ?? 'Could not apply tab scope.');
      setTabAssignments((prev) => {
        const next = { ...prev };
        if (tabId === null) delete next[profile.id];
        else next[profile.id] = tabId;
        return next;
      });
      return true;
    } catch (error) {
      setTabScopeError(error instanceof Error ? error.message : 'Could not apply tab scope.');
      return false;
    }
  };

  const toggleTabOnly = async (profile: Profile, enabled: boolean) => {
    if (enabled) {
      if (currentTabId === null || !(await updateProfile({ ...profile, tabOnly: true }))) return;
      await assignTab(profile, currentTabId);
    } else {
      if (!(await assignTab(profile, null))) return;
      await updateProfile({ ...profile, tabOnly: false });
    }
  };

  return (
    <div class="popup">
      <div class="topbar">
        <div class="brand">
          <span class="brand-mark">H</span>
          <span class="brand-copy">
            <strong>HTTPatch</strong>
            <small>Header workspace</small>
          </span>
        </div>
        <div class="row">
          <label class="row global-toggle" title="Pause all header modifications">
            <span class={schema.settings.paused ? 'state-pill paused' : 'state-pill'}>
              {schema.settings.paused ? 'Paused' : 'Active'}
            </span>
            <Switch
              checked={!schema.settings.paused}
              onChange={(v) => patchSettings({ paused: !v })}
            />
          </label>
        </div>
      </div>

      {profiles.length === 0 ? (
        <div class="card">
          <p class="muted">No profiles yet.</p>
          <button class="primary" onClick={addProfile}>
            Create your first profile
          </button>
        </div>
      ) : (
        <>
          <div class="field">
            <div class="section-heading">
              <span class="section-label">Profile</span>
              <span class="muted">{profiles.length} total</span>
            </div>
            <div class="inline">
              <select
                aria-label="Selected profile"
                value={active?.id}
                onChange={(e) =>
                  patchSettings({ activeProfileId: (e.target as HTMLSelectElement).value })
                }
              >
                {profiles.map((p) => (
                  <option value={p.id} key={p.id}>
                    {p.enabled ? '● ' : '○ '}
                    {p.name}
                  </option>
                ))}
              </select>
              <Switch
                checked={active?.enabled ?? false}
                onChange={(v) => active && updateProfile({ ...active, enabled: v })}
                title="Enable this profile"
              />
              <button class="ghost" title="Add profile" onClick={addProfile}>
                +
              </button>
            </div>
          </div>

          {active && currentSite && (
            <div class="site-scope">
              <span class="site-name" title={currentSite.hostname}>
                {currentSite.hostname}
              </span>
              <button
                class="site-scope-button"
                disabled={scopedToCurrentSite}
                title="Replace this profile's include filters with this site's domain. Applies in every tab."
                onClick={() =>
                  updateProfile({
                    ...active,
                    filters: {
                      ...active.filters,
                      urlFilters: [
                        ...active.filters.urlFilters.filter((f) => f.mode === 'exclude'),
                        currentSite.filter,
                      ],
                    },
                  })
                }
              >
                {scopedToCurrentSite ? 'Scoped to this site' : 'Scope to this site'}
              </button>
            </div>
          )}

          {active && currentTabId !== null && (
            <div class="tab-scope">
              <span>
                <strong>This tab only</strong>
                <small>
                  {active.tabOnly
                    ? assignedTab === currentTabId
                      ? 'Rules stay in this tab'
                      : 'Assigned to another tab or waiting for one'
                    : 'Apply across matching tabs'}
                </small>
              </span>
              {active.tabOnly && assignedTab !== currentTabId ? (
                <button onClick={() => void assignTab(active, currentTabId)}>Use this tab</button>
              ) : (
                <Switch
                  checked={active.tabOnly === true}
                  onChange={(v) => void toggleTabOnly(active, v)}
                  title="Apply this profile only in the assigned browser tab"
                />
              )}
            </div>
          )}
          {tabScopeError && <div class="alert error">{tabScopeError}</div>}

          {active && (
            <div class="card header-card">
              <div class="section-heading">
                <span class="section-label">Header rules</span>
                <span
                  class="rule-count"
                  style={`--profile-color:${active.color ?? DEFAULT_BADGE_COLOR}`}
                >
                  {enabledHeaders} enabled
                </span>
              </div>
              <HeaderTable
                headers={active.headers}
                onChange={(headers) => updateProfile({ ...active, headers })}
              />
            </div>
          )}
        </>
      )}

      <StatusBar status={status} />

      <div class="popup-actions">
        <button class="manage-button" onClick={openOptions}>
          Manage profiles & filters →
        </button>
      </div>
      <ProjectFooter compact />
    </div>
  );
}
