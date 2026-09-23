import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import type {
  HeaderRule,
  HeaderTarget,
  HeaderOp,
  Profile,
  ResourceType,
  UrlFilter,
} from '@/core/types';
import { ALL_RESOURCE_TYPES, APPEND_ALLOWLIST } from '@/core/constants';
import type { ImportSummary } from '@/core/import-analysis';
import type { ApplyStatus, SyncStatus } from '@/messaging/messages';
import { newHeader } from './factory';
import { newId } from '@/core/id';
import { formatCookieHeader, parseCookieHeader, setCspDirective } from '@/core/common-headers';
import { HeaderNamePicker } from './HeaderNamePicker';

export function Switch({
  checked,
  onChange,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  title?: string;
}) {
  return (
    <label class="switch" title={title}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange((e.target as HTMLInputElement).checked)}
      />
      <span class="slider" />
    </label>
  );
}

/** Compact status line: rule count, warnings, limit errors. */
export function StatusBar({ status }: { status: ApplyStatus | null }) {
  if (!status) return null;
  return (
    <div class="statusbar">
      {status.error && <div class="alert error">{status.error}</div>}
      {status.warnings.map((w, i) => (
        <div class="alert warn" key={i}>
          {w.message}
        </div>
      ))}
      <div class="muted" style="font-size:11px">
        {status.paused
          ? 'Paused — no headers are being modified.'
          : status.applied
            ? `${status.ruleCount} active rule${status.ruleCount === 1 ? '' : 's'}.`
            : 'Not applied.'}
      </div>
    </div>
  );
}

function appendDisallowed(h: HeaderRule): boolean {
  return (
    h.operation === 'append' &&
    h.target === 'request' &&
    h.name.trim().length > 0 &&
    !APPEND_ALLOWLIST.has(h.name.trim().toLowerCase())
  );
}

export function HeaderRowEditor({
  header,
  position,
  onChange,
  onDuplicate,
  onDelete,
}: {
  header: HeaderRule;
  position: number;
  onChange: (h: HeaderRule) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const set = (patch: Partial<HeaderRule>) => onChange({ ...header, ...patch });
  const isRemove = header.operation === 'remove';
  const warnAppend = appendDisallowed(header);
  const isCookie = header.editor === 'request-cookie' || header.editor === 'response-cookie';
  const responseCookie = header.editor === 'response-cookie';
  const cookie = isCookie ? parseCookieHeader(header.value ?? '', responseCookie) : null;
  const setCookie = (patch: Partial<NonNullable<typeof cookie>>) => {
    if (!cookie) return;
    set({ value: formatCookieHeader({ ...cookie, ...patch }, responseCookie) });
  };

  return (
    <div class={`hrow${header.editor ? '' : ' generic'}`}>
      <div class="hrow-top">
        <Switch
          checked={header.enabled}
          onChange={(v) => set({ enabled: v })}
          title="Enable this header"
        />
        {header.editor ? (
          <span class="rule-kind">
            {header.editor === 'request-cookie'
              ? 'Request cookie'
              : header.editor === 'response-cookie'
                ? 'Set-Cookie response'
                : 'CSP response'}
          </span>
        ) : (
          <>
            <select
              value={header.target}
              onChange={(e) =>
                set({ target: (e.target as HTMLSelectElement).value as HeaderTarget })
              }
              title="Request or response"
            >
              <option value="request">Request</option>
              <option value="response">Response</option>
            </select>
            <select
              value={header.operation}
              onChange={(e) =>
                set({ operation: (e.target as HTMLSelectElement).value as HeaderOp })
              }
              title="Operation"
            >
              <option value="set">Set</option>
              <option value="append">Append</option>
              <option value="remove">Remove</option>
            </select>
          </>
        )}
        <button
          class="ghost hrow-copy"
          aria-label="Duplicate header"
          title="Duplicate header"
          onClick={onDuplicate}
        >
          ⧉
        </button>
        <button class="ghost danger hrow-del" aria-label="Delete" title="Delete" onClick={onDelete}>
          ✕
        </button>
      </div>
      {isCookie ? (
        <>
          <div class="hrow-fields">
            <input
              type="text"
              aria-label="Cookie name"
              placeholder="Cookie name"
              value={cookie?.name ?? ''}
              onInput={(e) => setCookie({ name: (e.target as HTMLInputElement).value })}
            />
            <input
              type="text"
              aria-label="Cookie value"
              placeholder="Cookie value"
              value={cookie?.value ?? ''}
              onInput={(e) => setCookie({ value: (e.target as HTMLInputElement).value })}
            />
          </div>
          {responseCookie && (
            <input
              type="text"
              aria-label="Set-Cookie attributes"
              placeholder="Attributes, e.g. Path=/; SameSite=Lax"
              value={cookie?.attributes ?? ''}
              onInput={(e) => setCookie({ attributes: (e.target as HTMLInputElement).value })}
            />
          )}
          <p class="rule-hint">
            Appends a cookie header; existing cookies with the same name are not replaced.
          </p>
        </>
      ) : header.editor === 'csp' ? (
        <div class="csp-editor">
          <textarea
            aria-label="Content Security Policy"
            rows={2}
            value={header.value ?? ''}
            onInput={(e) => set({ value: (e.target as HTMLTextAreaElement).value })}
          />
          <div class="csp-presets">
            {[
              ['default-src', "'self'"],
              ['script-src', "'self'"],
              ['connect-src', "'self'"],
              ['img-src', "'self' data:"],
              ['object-src', "'none'"],
              ['frame-ancestors', "'none'"],
            ].map(([name, value]) => (
              <button
                key={name}
                class="ghost"
                onClick={() => set({ value: setCspDirective(header.value ?? '', name, value) })}
              >
                + {name}
              </button>
            ))}
          </div>
          <p class="rule-hint">
            Review the policy and scope before enabling; CSP can block page resources.
          </p>
        </div>
      ) : (
        <div class="hrow-fields">
          <HeaderNamePicker
            value={header.name}
            target={header.target}
            invalid={warnAppend}
            onChange={(name) => set({ name })}
          />
          <input
            type="text"
            placeholder={isRemove ? '(no value)' : 'Value'}
            value={header.value ?? ''}
            disabled={isRemove}
            onInput={(e) => set({ value: (e.target as HTMLInputElement).value })}
          />
        </div>
      )}
      <label class="header-comment">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.8"
          aria-hidden="true"
        >
          <path d="M7 18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-7l-5 4z" />
        </svg>
        <input
          type="text"
          aria-label={`Header ${position} note (optional)`}
          placeholder="Add a note"
          value={header.comment ?? ''}
          onInput={(e) => set({ comment: (e.target as HTMLInputElement).value || undefined })}
        />
      </label>
      {warnAppend && (
        <div class="hrow-note alert warn">
          “Append” is only allowed on a fixed set of request headers. Use “Set” instead.
        </div>
      )}
    </div>
  );
}

export function HeaderTable({
  headers,
  onChange,
}: {
  headers: HeaderRule[];
  onChange: (headers: HeaderRule[]) => void;
}) {
  const update = (id: string, h: HeaderRule) => onChange(headers.map((x) => (x.id === id ? h : x)));
  const remove = (id: string) => onChange(headers.filter((x) => x.id !== id));
  const duplicate = (id: string) => {
    const index = headers.findIndex((h) => h.id === id);
    if (index < 0) return;
    const copy = { ...headers[index], id: newId() };
    onChange([...headers.slice(0, index + 1), copy, ...headers.slice(index + 1)]);
  };
  const add = () => onChange([...headers, newHeader()]);
  const addRequestCookie = () =>
    onChange([
      ...headers,
      newHeader({
        editor: 'request-cookie',
        target: 'request',
        operation: 'append',
        name: 'Cookie',
      }),
    ]);
  const addResponseCookie = () =>
    onChange([
      ...headers,
      newHeader({
        editor: 'response-cookie',
        target: 'response',
        operation: 'append',
        name: 'Set-Cookie',
      }),
    ]);
  const addCsp = () =>
    onChange([
      ...headers,
      newHeader({
        editor: 'csp',
        target: 'response',
        operation: 'set',
        name: 'Content-Security-Policy',
        value: "default-src 'self'; object-src 'none'; base-uri 'self'",
        enabled: false,
      }),
    ]);

  return (
    <div class="htable">
      {headers.length === 0 && (
        <div class="muted empty-headers">No header rules yet. Add one to get started.</div>
      )}
      {headers.map((h, index) => (
        <HeaderRowEditor
          key={h.id}
          header={h}
          position={index + 1}
          onChange={(next) => update(h.id, next)}
          onDuplicate={() => duplicate(h.id)}
          onDelete={() => remove(h.id)}
        />
      ))}
      <div class="quick-add">
        <button class="ghost" onClick={add}>
          + Header
        </button>
        <button class="ghost" onClick={addRequestCookie}>
          + Request cookie
        </button>
        <button class="ghost" onClick={addResponseCookie}>
          + Set-Cookie
        </button>
        <button class="ghost" onClick={addCsp}>
          + CSP
        </button>
      </div>
    </div>
  );
}

export function FilterEditor({
  filters,
  onChange,
}: {
  filters: Profile['filters'];
  onChange: (f: Profile['filters']) => void;
}) {
  const setUrl = (i: number, patch: Partial<UrlFilter>) =>
    onChange({
      ...filters,
      urlFilters: filters.urlFilters.map((f, idx) => (idx === i ? { ...f, ...patch } : f)),
    });
  const addUrl = () =>
    onChange({
      ...filters,
      urlFilters: [...filters.urlFilters, { kind: 'wildcard', mode: 'include', pattern: '' }],
    });
  const removeUrl = (i: number) =>
    onChange({ ...filters, urlFilters: filters.urlFilters.filter((_, idx) => idx !== i) });

  const toggleType = (t: ResourceType) => {
    const has = filters.resourceTypes.includes(t);
    onChange({
      ...filters,
      resourceTypes: has
        ? filters.resourceTypes.filter((x) => x !== t)
        : [...filters.resourceTypes, t],
    });
  };

  return (
    <div class="filters">
      <div class="section-label">URL filters</div>
      {filters.urlFilters.map((f, i) => (
        <div class="hrow" key={i}>
          <select
            value={f.mode}
            onChange={(e) =>
              setUrl(i, { mode: (e.target as HTMLSelectElement).value as UrlFilter['mode'] })
            }
          >
            <option value="include">Include</option>
            <option value="exclude">Exclude</option>
          </select>
          <select
            value={f.kind}
            onChange={(e) =>
              setUrl(i, { kind: (e.target as HTMLSelectElement).value as UrlFilter['kind'] })
            }
          >
            <option value="wildcard">Wildcard</option>
            <option value="regex">Regex</option>
          </select>
          <input
            type="text"
            placeholder={f.kind === 'regex' ? '^https://.*\\.example\\.com/' : '||example.com^'}
            value={f.pattern}
            onInput={(e) => setUrl(i, { pattern: (e.target as HTMLInputElement).value })}
          />
          <button class="ghost danger" title="Delete filter" onClick={() => removeUrl(i)}>
            ✕
          </button>
        </div>
      ))}
      <button class="ghost" onClick={addUrl}>
        + Add URL filter
      </button>
      <p class="muted" style="font-size:11px;margin:6px 0 0">
        No include filter means the profile applies to all URLs. Excludes must be bare domains (e.g.{' '}
        <code>ads.example.com</code>) in v1.
      </p>

      <div class="section-label" style="margin-top:12px">
        Resource types <span class="muted">(none selected = all)</span>
      </div>
      <div class="chips">
        {ALL_RESOURCE_TYPES.map((t) => (
          <label class={`chip ${filters.resourceTypes.includes(t) ? 'on' : ''}`} key={t}>
            <input
              type="checkbox"
              checked={filters.resourceTypes.includes(t)}
              onChange={() => toggleType(t)}
            />
            {t}
          </label>
        ))}
      </div>
    </div>
  );
}

export function Card({ children }: { children: ComponentChildren }) {
  return <div class="card">{children}</div>;
}

function formatAgo(ts: number | undefined, now: number): string {
  if (!ts) return 'never';
  const secs = Math.max(0, Math.round((now - ts) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function formatKb(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Sidebar sync controls. Sync is ON by default, so the statement of what
 * replication means for header values — routinely tokens or cookies — is shown
 * while it is enabled, not only before opting in. Same disclosure the export
 * flow makes.
 */
export function SyncPanel({
  status,
  busy,
  now,
  onToggle,
  onSyncNow,
  onClearRemote,
}: {
  status: SyncStatus | null;
  busy: boolean;
  now: number;
  onToggle: (enabled: boolean) => void;
  onSyncNow: () => void;
  onClearRemote: () => void;
}) {
  const enabled = status?.enabled ?? false;
  const unavailable = status !== null && !status.available;
  // Sync is off here but a copy is still sitting in the browser account, so give
  // an explicit way to remove it — those items contain header values.
  const orphanedRemote = !enabled && !unavailable && (status?.remoteProfileCount ?? 0) > 0;

  return (
    <div style="margin-top:16px">
      <div class="section-label">Sync</div>
      <label class="inline" style="margin-bottom:6px">
        <Switch checked={enabled} onChange={onToggle} title="Sync profiles across your devices" />
        <span>{enabled ? 'Syncing profiles' : 'Not syncing'}</span>
      </label>

      {unavailable && (
        <p class="muted" style="font-size:11px;margin:6px 0 0">
          This browser has no usable sync area — you may be signed out, or sync may be disabled by
          policy. Profiles are still saved on this device.
        </p>
      )}

      {!enabled && !unavailable && (
        <p class="muted" style="font-size:11px;margin:6px 0 0">
          Copies your profiles to this browser account&rsquo;s sync data so they follow you to your
          other devices. Header values — including Authorization tokens and cookies — are part of
          that copy.
        </p>
      )}

      {enabled && (
        <>
          <div class="inline" style="margin-top:6px">
            <button class="ghost" onClick={onSyncNow} disabled={busy}>
              {busy ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          {/*
            "Last updated", not "Last synced": this timestamp is when we last
            wrote the sync area, which is all we can actually know. The browser
            uploads separately, and storage.sync accepts writes whether or not
            the user is signed in — there is no API to ask whether replication is
            really happening. Claiming "synced" would tell a signed-out user
            their devices agree when nothing has left the machine.
          */}
          <p class="muted" style="font-size:11px;margin:6px 0 0">
            Last updated {formatAgo(status?.lastSyncedAt, now)}.
            {status?.bytesInUse !== null && status?.bytesInUse !== undefined && (
              <>
                {' '}
                Using {formatKb(status.bytesInUse)} of {formatKb(status.quotaBytes)}.
              </>
            )}
          </p>
          {/*
            Stated while sync is ON, not just before enabling it: sync starts on,
            so this may be the first time the user learns what leaves the machine.
          */}
          <p class="muted" style="font-size:11px;margin:6px 0 0">
            Profiles — including header values such as tokens and cookies — are stored in this
            browser account&rsquo;s sync data. Your browser copies them to your other devices when
            you are signed in to it; while you are signed out they stay on this device.
          </p>
        </>
      )}

      {orphanedRemote && (
        <div style="margin-top:6px">
          <p class="muted" style="font-size:11px;margin:0 0 6px">
            {status?.remoteProfileCount} profile
            {status?.remoteProfileCount === 1 ? '' : 's'} are still stored in this browser
            account&rsquo;s sync data.
          </p>
          <button class="ghost danger" onClick={onClearRemote} disabled={busy}>
            Remove synced copy
          </button>
        </div>
      )}

      {status?.lastError && (
        <div class="alert error" style="font-size:11px;margin-top:6px">
          {status.lastError}
        </div>
      )}

      {status && status.conflicts.length > 0 && (
        <div class="alert warn" style="font-size:11px;margin-top:6px">
          A newer edit from another device replaced your local copy of:{' '}
          {status.conflicts.join(', ')}.
        </div>
      )}

      {status && status.skipped.length > 0 && (
        <div class="alert warn" style="font-size:11px;margin-top:6px">
          Not synced (still saved on this device):
          <ul class="modal-flags">
            {status.skipped.map((s) => (
              <li key={s.profileId}>
                “{s.profileName}” —{' '}
                {s.reason === 'too-large'
                  ? `too large for one sync item (${formatKb(s.bytes)}, limit 8 KB)`
                  : 'sync storage is full'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * One-time banner for users who are syncing without having chosen to — sync is
 * on by default, including for installs upgrading from before the feature, so
 * this is the only thing that actively tells them their profiles (and the tokens
 * in them) are now leaving the machine. A line in the sidebar isn't enough for a
 * default that was applied retroactively.
 *
 * It disappears for good once acknowledged, and never appears for someone who
 * turned sync on themselves — working the toggle counts as acknowledgement.
 */
export function SyncDefaultNotice({
  onDismiss,
  onTurnOff,
}: {
  onDismiss: () => void;
  onTurnOff: () => void;
}) {
  return (
    <div class="alert warn" style="display:flex;flex-direction:column;gap:8px">
      <div>
        <strong>Your profiles are now syncing across your devices.</strong>
        <p style="margin:6px 0 0">
          HTTPatch keeps a copy in your browser account so your profiles follow you to your other
          signed-in devices. <strong>Header values are part of that copy</strong> — if a profile
          holds an Authorization token or a cookie, it is stored there too.
        </p>
      </div>
      <div class="inline">
        <button class="ghost danger" onClick={onTurnOff}>
          Turn sync off
        </button>
        <button class="primary" onClick={onDismiss}>
          Got it
        </button>
      </div>
    </div>
  );
}

/**
 * Shown the first time a device syncs when both sides already hold profiles.
 * Merge is the default and listed first: duplicate names are survivable, and
 * silently losing a profile set is not.
 */
export function SyncMergeDialog({
  localCount,
  remoteCount,
  onChoose,
  onCancel,
}: {
  localCount: number;
  remoteCount: number;
  onChoose: (mode: 'merge' | 'keep-local' | 'keep-remote') => void;
  onCancel: () => void;
}) {
  const mergeRef = useRef<HTMLButtonElement>(null);
  const plural = (n: number) => (n === 1 ? '' : 's');

  useEffect(() => {
    mergeRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div class="modal-backdrop" onClick={onCancel}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Start syncing"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Start syncing</h2>
        <p class="muted" style="margin:4px 0 0">
          This device has {localCount} profile{plural(localCount)}, and your browser account already
          has {remoteCount} synced profile{plural(remoteCount)}. Choose how to combine them.
        </p>

        <div class="alert warn" style="margin-top:12px">
          Export a backup first if you are unsure — “Use the synced copy” discards the profiles on
          this device.
        </div>

        <div class="modal-actions" style="flex-direction:column;align-items:stretch;gap:8px">
          <button class="primary" ref={mergeRef} onClick={() => onChoose('merge')}>
            Keep both (recommended)
          </button>
          <button class="ghost" onClick={() => onChoose('keep-local')}>
            Use this device&rsquo;s profiles — replaces the synced copy
          </button>
          <button class="ghost danger" onClick={() => onChoose('keep-remote')}>
            Use the synced copy — discards this device&rsquo;s {localCount} profile
            {plural(localCount)}
          </button>
          <button class="ghost" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Confirmation dialog shown before an import is committed (finding L-01). It
 * summarises every profile, header operation, and target URL in the file, and
 * prominently flags any rule that would modify a security-relevant response
 * header — so a hostile file can't silently weaken CSP/HSTS/CORS across all the
 * user's sites. Nothing is written to storage until the user confirms.
 */
export function ImportPreview({
  summary,
  warnings,
  onConfirm,
  onCancel,
}: {
  summary: ImportSummary;
  warnings: string[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const plural = (n: number) => (n === 1 ? '' : 's');
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Close on Escape and move focus into the dialog when it opens — this is the
  // L-01 confirmation gate, so it must be dismissible and reachable by keyboard.
  useEffect(() => {
    cancelRef.current?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div class="modal-backdrop" onClick={onCancel}>
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Review import"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Review import</h2>
        <p class="muted" style="margin:4px 0 0">
          Importing {summary.profileCount} profile{plural(summary.profileCount)} with{' '}
          {summary.totalHeaders} header rule{plural(summary.totalHeaders)}. Nothing is applied until
          you confirm.
        </p>

        {summary.securityFlags.length > 0 && (
          <div class="alert error" style="margin-top:12px">
            <strong>⚠ This import modifies security-relevant response headers.</strong>
            <p style="margin:6px 0 0">
              The rules below could weaken the security of the sites you visit (e.g. relax CSP,
              HSTS, framing, or CORS). Only continue if you trust the source of this file.
            </p>
            <ul class="modal-flags">
              {summary.securityFlags.map((f, i) => (
                <li key={i}>
                  <code>{f.operation}</code> {f.target} <code>{f.headerName}</code>
                  <span class="muted"> — in “{f.profileName}”</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div class="modal-scroll">
          {summary.profiles.map((p, i) => (
            <div class="import-profile" key={i}>
              <div class="import-profile-head">
                <strong>{p.name}</strong>
                <span class="muted">
                  {p.enabled ? 'enabled' : 'disabled'} · {p.headerCount} header
                  {plural(p.headerCount)}
                </span>
              </div>
              {p.ops.length > 0 && (
                <ul class="import-ops">
                  {p.ops.map((op, j) => (
                    <li key={j} class={op.securitySensitive ? 'sensitive' : ''}>
                      <code>{op.operation}</code> {op.target} <code>{op.name || '(unnamed)'}</code>
                      {op.securitySensitive && <span class="flag-warn"> ⚠ security header</span>}
                    </li>
                  ))}
                </ul>
              )}
              <div class="muted import-urls">
                {p.urlPatterns.length ? `URLs: ${p.urlPatterns.join(', ')}` : 'Applies to all URLs'}
              </div>
            </div>
          ))}
        </div>

        {warnings.length > 0 && (
          <div class="alert warn">
            {warnings.length} row{plural(warnings.length)} adjusted or skipped during validation:
            <ul class="modal-flags">
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div class="modal-actions">
          <button class="ghost" ref={cancelRef} onClick={onCancel}>
            Cancel
          </button>
          <button class="primary" onClick={onConfirm}>
            Import {summary.profileCount} profile{plural(summary.profileCount)}
          </button>
        </div>
      </div>
    </div>
  );
}
