import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { api } from "../api";
import { useStore } from "../store";
import { useTables } from "../lib/fetchMeta";
import { friendlyError } from "../lib/errors";
import { ROUTES } from "../lib/navigation";
import {
  ACTIONS,
  DEPTHS,
  buildMatrix,
  mergePrivileges,
  neededDepth,
  parseRecordRef,
  privilegesCache,
  rolesCache,
  rolesOf,
  userRolesCache,
  usersCache,
  verdicts,
  type Grant,
  type Matrix,
} from "../lib/security";
import { Combo } from "./FetchNodePanel";
import { Search, Refresh, Shield, User, Loader, Check, X, AlertTriangle } from "./Icon";
import type { AccessCheck, SecurityRole, SecurityUser } from "../types";

type Tab = "users" | "roles" | "compare";
const TABS: { key: Tab; label: string }[] = [
  { key: "users", label: "Users" },
  { key: "roles", label: "Roles" },
  { key: "compare", label: "Compare roles" },
];

export function SecurityView() {
  const activeId = useStore((s) => s.activeId);
  const { tab: raw } = useParams();
  const tab: Tab = raw === "roles" || raw === "compare" ? raw : "users";
  const navigate = useNavigate();

  if (!activeId) {
    return <div className="flex h-full items-center justify-center text-sm text-subtle">Select an environment to look at its security.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-end gap-1 border-b border-line bg-s1 px-4" role="tablist" aria-label="Security">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className="tab h-10 px-2" onClick={() => navigate(`${ROUTES.security}/${t.key}`)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {tab === "users" && <UsersTab connId={activeId} />}
        {tab === "roles" && <RolesTab connId={activeId} />}
        {tab === "compare" && <CompareTab connId={activeId} />}
      </div>
    </div>
  );
}

/* ---------- shared ---------- */

function useTableLabel(connId: string) {
  const { tables } = useTables(connId);
  return useMemo(() => {
    const map = new Map((tables ?? []).map((t) => [t.logicalName, t.displayName]));
    return (t: string) => map.get(t) || undefined;
  }, [tables]);
}

/** Privileges of several roles, loaded (and cached) one role at a time. */
function useRolePrivileges(connId: string, roleIds: string[]) {
  const data = privilegesCache.useStore((s) => s.data);
  const errors = privilegesCache.useStore((s) => s.errors);
  const key = roleIds.join(",");
  useEffect(() => {
    roleIds.forEach((id) => privilegesCache.load(connId, id).catch(() => {}));
    // Keyed by the ids, not the array.
  }, [connId, key]);
  const lists = roleIds.map((id) => data[`${connId}|${id}`]);
  const error = roleIds.map((id) => errors[`${connId}|${id}`]).find(Boolean);
  return { lists, loading: lists.some((l) => !l) && !error, error };
}

function DepthDot({ depth, title }: { depth: number; title?: string }) {
  const pct = [0, 25, 50, 75, 100][depth] ?? 0;
  return (
    <span
      className={`inline-block h-3.5 w-3.5 shrink-0 rounded-full border ${depth ? "border-brand" : "border-dashed border-line-strong"}`}
      style={depth ? { background: `conic-gradient(var(--brand) 0 ${pct}%, transparent ${pct}% 100%)` } : undefined}
      title={title ?? DEPTHS[depth]}
      aria-label={DEPTHS[depth]}
    />
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-subtle">
      {DEPTHS.map((d, i) => (
        <span key={d} className="flex items-center gap-1.5">
          <DepthDot depth={i} /> {d}
        </span>
      ))}
    </div>
  );
}

const grantTitle = (g: Grant | undefined, source?: string) =>
  `${source ? `${source}: ` : ""}${DEPTHS[g?.depth ?? 0]}${g?.from.length ? `\nfrom ${g.from.join(", ")}` : ""}`;

function PrivilegeMatrix({ matrix, sources, emptyText }: { matrix: Matrix; sources?: string[]; emptyText: string }) {
  const [q, setQ] = useState("");
  const [only, setOnly] = useState(true);
  const compare = (sources?.length ?? 0) > 1;
  const differs = (grants: (Grant | undefined)[]) => grants.some((g) => (g?.depth ?? 0) !== (grants[0]?.depth ?? 0));
  const needle = q.trim().toLowerCase();
  const rows = matrix.rows.filter((r) => {
    if (needle && !r.table.includes(needle) && !r.label.toLowerCase().includes(needle)) return false;
    if (!only) return true;
    const cells = ACTIONS.map((a) => r.cells[a]);
    return compare ? cells.some(differs) : cells.some((g) => (g[0]?.depth ?? 0) > 0);
  });
  const misc = matrix.misc.filter((m) => (!needle || m.name.toLowerCase().includes(needle)) && (!compare || !only || differs(m.grants)));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-subtle" />
          <input className="input !h-8 !pl-7 !text-[12.5px]" placeholder="Filter tables…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter tables" />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-muted">
          <input type="checkbox" checked={only} onChange={(e) => setOnly(e.target.checked)} className="accent-[var(--brand)]" />
          {compare ? "Only differences" : "Only tables with access"}
        </label>
        <span className="ml-auto">
          <Legend />
        </span>
      </div>
      {compare && sources && (
        <div className="flex items-center gap-4 text-[12px] text-muted">
          {sources.map((s, i) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className="font-mono text-subtle">{i === 0 ? "left" : "right"}</span> {s}
            </span>
          ))}
        </div>
      )}
      <div className="card overflow-auto">
        <table className="w-full text-[12.5px]">
          <thead className="sticky top-0 z-10 bg-s2">
            <tr className="border-b border-line text-left text-subtle">
              <th className="px-3 py-2 font-medium">Table</th>
              {ACTIONS.map((a) => (
                <th key={a} className="px-2 py-2 text-center font-medium">
                  {a === "AppendTo" ? "Append to" : a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-3 py-6 text-center text-subtle">
                  {emptyText}
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.table} className="row border-b border-line last:border-0">
                  <td className="max-w-[280px] px-3 py-1.5">
                    <span className="block truncate" title={r.table}>
                      {r.label}
                    </span>
                    {r.label !== r.table && <span className="block truncate font-mono text-[11px] text-subtle">{r.table}</span>}
                  </td>
                  {ACTIONS.map((a) => {
                    const grants = r.cells[a];
                    return (
                      <td key={a} className={`px-2 py-1.5 text-center ${compare && differs(grants) ? "bg-warning/10" : ""}`}>
                        <span className="inline-flex items-center gap-1">
                          {grants.map((g, i) => (
                            <DepthDot key={i} depth={g?.depth ?? 0} title={grantTitle(g, sources?.[i])} />
                          ))}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {misc.length > 0 && (
        <details className="card px-4 py-3">
          <summary className="cursor-pointer text-[13px] font-semibold">
            Other privileges <span className="font-normal text-subtle">({misc.length})</span>
          </summary>
          <ul className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1">
            {misc.map((m) => (
              <li key={m.name} className={`flex items-center gap-2 text-[12.5px] ${compare && differs(m.grants) ? "text-warning" : ""}`}>
                <span className="inline-flex gap-1">
                  {m.grants.map((g, i) => (
                    <DepthDot key={i} depth={g?.depth ?? 0} title={grantTitle(g, sources?.[i])} />
                  ))}
                </span>
                <span className="truncate font-mono">{m.name.replace(/^prv/, "")}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function ListShell({
  search,
  onSearch,
  placeholder,
  onRefresh,
  loading,
  error,
  extra,
  children,
}: {
  search: string;
  onSearch: (v: string) => void;
  placeholder: string;
  onRefresh: () => void;
  loading: boolean;
  error?: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-col border-r border-line bg-s1">
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="relative flex-1">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input className="input !pl-8" placeholder={placeholder} value={search} onChange={(e) => onSearch(e.target.value)} aria-label={placeholder} />
        </div>
        <button className="btn btn-ghost btn-icon" onClick={onRefresh} disabled={loading} title="Read again" aria-label="Refresh">
          <Refresh size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </div>
      {extra}
      <ul className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3" role="listbox">
        {error ? (
          <li className="px-3 py-8 text-center text-xs">
            <div className="text-warning">Couldn't read the list.</div>
            <div className="mt-1 break-words text-subtle">{error}</div>
            <button className="btn btn-secondary btn-sm mt-3" onClick={onRefresh}>
              <Refresh size={12} /> Retry
            </button>
          </li>
        ) : (
          children
        )}
      </ul>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 10 }, (_, i) => (
        <li key={i} className="space-y-1.5 px-2.5 py-2">
          <div className="skeleton h-3 w-2/3" />
          <div className="skeleton h-2.5 w-1/2" />
        </li>
      ))}
    </>
  );
}

/* ---------- Users ---------- */

type UserPane = "roles" | "privileges" | "access";

function UsersTab({ connId }: { connId: string }) {
  const users = usersCache.useEntry(connId);
  const [params, setParams] = useSearchParams();
  const selected = params.get("user");
  const [q, setQ] = useState("");
  const [hideDisabled, setHideDisabled] = useState(true);
  const [hideApps, setHideApps] = useState(true);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (users.data ?? []).filter(
      (u) =>
        (!hideDisabled || !u.disabled) &&
        (!hideApps || (!u.application && u.accessMode !== 3 && u.accessMode !== 4)) &&
        (!needle || u.name.toLowerCase().includes(needle) || u.email?.toLowerCase().includes(needle) || u.username?.toLowerCase().includes(needle))
    );
  }, [users.data, q, hideDisabled, hideApps]);
  const user = users.data?.find((u) => u.id === selected) ?? null;

  return (
    <div className="grid h-full grid-cols-[clamp(280px,26vw,340px)_minmax(0,1fr)]">
      <ListShell
        search={q}
        onSearch={setQ}
        placeholder="Find a user…"
        onRefresh={users.reload}
        loading={users.loading}
        error={users.error}
        extra={
          <div className="flex gap-4 px-4 pt-2 text-[12px] text-muted">
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={hideDisabled} onChange={(e) => setHideDisabled(e.target.checked)} className="accent-[var(--brand)]" />
              Hide disabled
            </label>
            <label className="flex cursor-pointer items-center gap-1.5">
              <input type="checkbox" checked={hideApps} onChange={(e) => setHideApps(e.target.checked)} className="accent-[var(--brand)]" />
              Hide app &amp; system users
            </label>
          </div>
        }
      >
        {!users.data ? (
          <SkeletonRows />
        ) : shown.length === 0 ? (
          <li className="px-3 py-8 text-center text-xs text-subtle">No users match.</li>
        ) : (
          shown.map((u) => (
            <li key={u.id}>
              <button
                role="option"
                aria-selected={u.id === selected}
                aria-current={u.id === selected ? "page" : undefined}
                className="nav-item nav-item-tall"
                onClick={() => setParams({ user: u.id }, { replace: true })}
              >
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-[13px] ${u.disabled ? "text-subtle line-through" : ""}`}>{u.name || u.username || "(no name)"}</span>
                  <span className="block truncate text-xs font-normal text-subtle">
                    {[u.email ?? u.username, u.businessUnit].filter(Boolean).join(" · ")}
                  </span>
                </span>
                {u.application && <span className="badge badge-neutral shrink-0 !text-[10.5px]">app</span>}
              </button>
            </li>
          ))
        )}
      </ListShell>
      <div className="min-h-0 overflow-y-auto">
        {user ? (
          <UserDetail key={user.id} connId={connId} user={user} />
        ) : (
          <Empty icon={<User size={20} />} title="No user selected" text="Pick a user to see their roles — their own and their teams' — and what they can do." />
        )}
      </div>
    </div>
  );
}

function UserDetail({ connId, user }: { connId: string; user: SecurityUser }) {
  const [pane, setPane] = useState<UserPane>("roles");
  const ur = userRolesCache.useEntry(connId, user.id);
  const navigate = useNavigate();
  // Role names say which team a role comes through (shown in the matrix tooltips).
  const roleList = useMemo(
    () => (ur.data ? rolesOf(ur.data).map((x) => ({ id: x.role.id, name: x.via ? `${x.role.name} (team ${x.via})` : x.role.name })) : []),
    [ur.data]
  );

  return (
    <div className="fade-in mx-auto max-w-[1080px] px-6 pb-10 pt-7 xl:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{user.name || user.username}</h2>
        {user.disabled && <span className="badge badge-warning">Disabled</span>}
        {user.application && <span className="badge badge-neutral">Application user</span>}
        {user.accessModeLabel && user.accessMode !== 0 && <span className="badge badge-neutral">{user.accessModeLabel}</span>}
      </div>
      <p className="mt-0.5 text-sm text-muted">
        {[user.title, user.email ?? user.username, user.businessUnit && `Business unit: ${user.businessUnit}`].filter(Boolean).join(" · ")}
      </p>

      <div className="seg mt-5" role="group" aria-label="Show">
        {(
          [
            ["roles", "Roles"],
            ["privileges", "Privileges"],
            ["access", "Check access to a record"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} aria-pressed={pane === k} onClick={() => setPane(k)}>
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {ur.error ? (
          <div className="text-sm text-warning">Couldn't read this user's roles: {ur.error}</div>
        ) : !ur.data ? (
          <div className="flex items-center gap-2 text-sm text-subtle">
            <Loader size={14} className="text-brand" /> Reading roles…
          </div>
        ) : pane === "roles" ? (
          <div className="space-y-4">
            <RoleCard
              title="Assigned to the user"
              roles={ur.data.direct}
              empty="No role assigned directly."
              onOpen={(r) => navigate(`${ROUTES.security}/roles?role=${r.rootId}`)}
            />
            {ur.data.teams.map((t) => (
              <RoleCard
                key={t.id}
                title={`Through team “${t.name}”`}
                hint={t.teamType}
                roles={t.roles}
                empty={t.error ? `Couldn't read: ${t.error}` : "This team has no roles."}
                onOpen={(r) => navigate(`${ROUTES.security}/roles?role=${r.rootId}`)}
              />
            ))}
            {ur.data.teams.length === 0 && <p className="text-xs text-subtle">Not a member of any team.</p>}
          </div>
        ) : pane === "privileges" ? (
          <EffectivePrivileges connId={connId} roles={roleList} />
        ) : (
          <AccessCheckPanel connId={connId} user={user} roles={roleList} teamIds={ur.data.teams.map((t) => t.id)} />
        )}
      </div>
    </div>
  );
}

function RoleCard({ title, hint, roles, empty, onOpen }: { title: string; hint?: string; roles: SecurityRole[]; empty: string; onOpen: (r: SecurityRole) => void }) {
  return (
    <section className="card overflow-hidden">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <h3 className="text-[13.5px] font-semibold">{title}</h3>
        {hint && <span className="badge badge-neutral">{hint}</span>}
        <span className="text-xs tabular-nums text-subtle">{roles.length}</span>
      </div>
      {roles.length === 0 ? (
        <div className="px-4 py-3 text-xs text-subtle">{empty}</div>
      ) : (
        <ul className="divide-y divide-line">
          {roles.map((r) => (
            <li key={r.id}>
              <button className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-s3" onClick={() => onOpen(r)}>
                <Shield size={14} className="shrink-0 text-subtle" />
                <span className="min-w-0 flex-1 truncate text-[13px]">{r.name}</span>
                <span className="shrink-0 text-[12px] text-subtle">{r.businessUnit}</span>
                {r.managed && <span className="badge badge-neutral shrink-0">managed</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function EffectivePrivileges({ connId, roles }: { connId: string; roles: { id: string; name: string }[] }) {
  const tableLabel = useTableLabel(connId);
  const { lists, loading, error } = useRolePrivileges(
    connId,
    roles.map((r) => r.id)
  );
  const matrix = useMemo(() => {
    if (loading || error) return null;
    const merged = mergePrivileges(roles.map((r, i) => ({ name: r.name, privileges: lists[i] ?? [] })));
    return buildMatrix([merged], tableLabel);
  }, [loading, error, lists, roles, tableLabel]);

  if (roles.length === 0) return <p className="text-sm text-subtle">The user has no roles, so no privileges.</p>;
  if (error) return <p className="text-sm text-warning">Couldn't read a role's privileges: {error}</p>;
  if (!matrix)
    return (
      <div className="flex items-center gap-2 text-sm text-subtle">
        <Loader size={14} className="text-brand" /> Reading the privileges of {roles.length} role{roles.length === 1 ? "" : "s"}…
      </div>
    );
  return (
    <div className="space-y-2">
      <p className="text-xs text-subtle">Every role together — the deepest level wins. Hover a dot to see which role gives it.</p>
      <PrivilegeMatrix matrix={matrix} emptyText="No table privileges." />
    </div>
  );
}

function AccessCheckPanel({ connId, user, roles, teamIds }: { connId: string; user: SecurityUser; roles: { id: string; name: string }[]; teamIds: string[] }) {
  const { tables, loading: tablesLoading } = useTables(connId);
  const tableOptions = useMemo(() => tables?.map((t) => ({ value: t.logicalName, label: t.displayName || undefined })), [tables]);
  const [table, setTable] = useState("");
  const [record, setRecord] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ check: AccessCheck; table: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { lists, loading: privLoading } = useRolePrivileges(
    connId,
    roles.map((r) => r.id)
  );

  const onRecord = (v: string) => {
    setRecord(v);
    const ref = parseRecordRef(v);
    if (ref.table) setTable(ref.table);
  };
  const ref = parseRecordRef(record);
  const run = async () => {
    if (!table || !ref.id) return;
    setBusy(true);
    setError(null);
    try {
      setResult({ check: await api.principalAccess(connId, user.id, table, ref.id), table });
    } catch (e) {
      setResult(null);
      setError(friendlyError(String(e)));
    } finally {
      setBusy(false);
    }
  };

  const effective = useMemo(
    () => (privLoading ? null : mergePrivileges(roles.map((r, i) => ({ name: r.name, privileges: lists[i] ?? [] })))),
    [privLoading, lists, roles]
  );
  const need = result ? neededDepth(result.check, user.id, teamIds) : null;
  const rows = result && effective && need ? verdicts(result.check, result.table, effective, need.depth) : null;

  return (
    <div className="space-y-4">
      <form
        className="card grid grid-cols-[220px_minmax(0,1fr)_auto] items-start gap-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <label className="block min-w-0">
          <span className="mb-1.5 block truncate text-xs font-medium text-muted">Table</span>
          <Combo value={table} onCommit={(v) => setTable(v.trim().toLowerCase())} options={tableOptions} loading={tablesLoading} placeholder="account" hintSpace />
        </label>
        <label className="block min-w-0">
          <span className="mb-1.5 block truncate text-xs font-medium text-muted">Record id or link</span>
          <input
            className="input !h-8 font-mono !text-[12.5px]"
            placeholder="Paste a GUID or the record's URL from the app"
            value={record}
            onChange={(e) => onRecord(e.target.value)}
            spellCheck={false}
          />
        </label>
        <div>
          <span className="invisible mb-1.5 block text-xs font-medium" aria-hidden="true">
            Check
          </span>
          <button type="submit" className="btn btn-primary" disabled={!table || !ref.id || busy}>
            {busy ? <Loader size={14} /> : <Shield size={14} />}
            Check
          </button>
        </div>
      </form>
      {record && !ref.id && <p className="-mt-2 text-xs text-warning">No record id found in that text.</p>}
      {error && (
        <div className="flex gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm" role="alert">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-danger" /> {error}
        </div>
      )}

      {result && (
        <section className="card overflow-hidden">
          <div className="border-b border-line px-4 py-3">
            <h3 className="text-[14px] font-semibold">
              {user.name} → {result.check.recordName ?? "record"} <span className="font-mono text-[12px] font-normal text-subtle">{result.table}</span>
            </h3>
            <p className="mt-1 text-[12.5px] text-muted">
              {result.check.ownerId ? (
                <>
                  Owner: <b>{result.check.owner ?? result.check.ownerId}</b>
                  {result.check.ownerKind === "team" ? " (team)" : ""} · Business unit: <b>{result.check.owningBusinessUnit ?? "—"}</b> · The user is in{" "}
                  <b>{result.check.userBusinessUnit}</b>
                </>
              ) : (
                <>This table is {result.check.ownership === "OrganizationOwned" ? "organization-owned" : result.check.ownership}.</>
              )}
            </p>
            {need && <p className="mt-1 text-[12.5px] text-muted">{need.reason} Needed level: <b>{need.depth ? DEPTHS[need.depth] : "any"}</b>.</p>}
          </div>
          {!rows ? (
            <div className="flex items-center gap-2 px-4 py-3 text-xs text-subtle">
              <Loader size={12} className="text-brand" /> Reading the user's privileges…
            </div>
          ) : (
            <ul className="divide-y divide-line">
              {rows.map((r) => (
                <li key={r.label} className="flex items-center gap-3 px-4 py-2">
                  <span className={`grid h-5 w-5 shrink-0 place-items-center rounded-full ${r.has ? "bg-success/15 text-success" : "bg-danger/15 text-danger"}`}>
                    {r.has ? <Check size={12} strokeWidth={3} /> : <X size={12} strokeWidth={3} />}
                  </span>
                  <span className="w-20 shrink-0 text-[13px] font-medium">{r.label}</span>
                  <DepthDot depth={r.depth} title={`${DEPTHS[r.depth]}${r.from.length ? ` · from ${r.from.join(", ")}` : ""}`} />
                  <span className="min-w-0 flex-1 text-[12.5px] text-muted">{r.why}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/* ---------- Roles ---------- */

function RolesTab({ connId }: { connId: string }) {
  const roles = rolesCache.useEntry(connId);
  const [params, setParams] = useSearchParams();
  const selected = params.get("role");
  const [q, setQ] = useState("");
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (roles.data ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle));
  }, [roles.data, q]);
  const role = roles.data?.find((r) => r.id === selected || r.rootId === selected) ?? null;

  return (
    <div className="grid h-full grid-cols-[clamp(260px,24vw,320px)_minmax(0,1fr)]">
      <ListShell search={q} onSearch={setQ} placeholder="Find a role…" onRefresh={roles.reload} loading={roles.loading} error={roles.error}>
        {!roles.data ? (
          <SkeletonRows />
        ) : (
          shown.map((r) => (
            <li key={r.id}>
              <button
                role="option"
                aria-selected={r.id === role?.id}
                aria-current={r.id === role?.id ? "page" : undefined}
                className="nav-item"
                onClick={() => setParams({ role: r.id }, { replace: true })}
              >
                <Shield size={14} className="shrink-0" />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                {r.managed && <span className="text-[10.5px] text-subtle">managed</span>}
              </button>
            </li>
          ))
        )}
      </ListShell>
      <div className="min-h-0 overflow-y-auto">
        {role ? (
          <RoleDetail key={role.id} connId={connId} role={role} />
        ) : (
          <Empty icon={<Shield size={20} />} title="No role selected" text="Pick a role to see its privileges, table by table." />
        )}
      </div>
    </div>
  );
}

function RoleDetail({ connId, role }: { connId: string; role: SecurityRole }) {
  const tableLabel = useTableLabel(connId);
  const privs = privilegesCache.useEntry(connId, role.id);
  const matrix = useMemo(
    () => (privs.data ? buildMatrix([mergePrivileges([{ name: role.name, privileges: privs.data }])], tableLabel) : null),
    [privs.data, role.name, tableLabel]
  );
  return (
    <div className="fade-in mx-auto max-w-[1080px] px-6 pb-10 pt-7 xl:px-8">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{role.name}</h2>
        <span className="badge badge-neutral">{role.managed ? "managed" : "unmanaged"}</span>
      </div>
      <p className="mt-0.5 text-sm text-muted">
        Business unit: {role.businessUnit}
        {privs.data && ` · ${privs.data.length} privileges`}
      </p>
      <div className="mt-5">
        {privs.error ? (
          <p className="text-sm text-warning">Couldn't read the privileges: {privs.error}</p>
        ) : !matrix ? (
          <div className="flex items-center gap-2 text-sm text-subtle">
            <Loader size={14} className="text-brand" /> Reading privileges…
          </div>
        ) : (
          <PrivilegeMatrix matrix={matrix} emptyText="This role has no table privileges." />
        )}
      </div>
    </div>
  );
}

/* ---------- Compare ---------- */

function CompareTab({ connId }: { connId: string }) {
  const roles = rolesCache.useEntry(connId);
  const tableLabel = useTableLabel(connId);
  const [params, setParams] = useSearchParams();
  const a = params.get("a") ?? "";
  const b = params.get("b") ?? "";
  const pick = (key: "a" | "b", id: string) => {
    const next = new URLSearchParams(params);
    next.set(key, id);
    setParams(next, { replace: true });
  };
  const ra = roles.data?.find((r) => r.id === a) ?? null;
  const rb = roles.data?.find((r) => r.id === b) ?? null;
  const ids = ra && rb ? [ra.id, rb.id] : [];
  const { lists, loading, error } = useRolePrivileges(connId, ids);
  const matrix = useMemo(() => {
    if (!ra || !rb || loading || error || !lists[0] || !lists[1]) return null;
    return buildMatrix(
      [mergePrivileges([{ name: ra.name, privileges: lists[0] }]), mergePrivileges([{ name: rb.name, privileges: lists[1] }])],
      tableLabel
    );
  }, [ra, rb, loading, error, lists, tableLabel]);

  const select = (key: "a" | "b", value: string) => (
    <select className="input !h-9" value={value} onChange={(e) => pick(key, e.target.value)} disabled={!roles.data} aria-label={key === "a" ? "First role" : "Second role"}>
      <option value="">{roles.data ? "Pick a role…" : "Loading roles…"}</option>
      {roles.data?.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1080px] px-6 pb-10 pt-7 xl:px-8">
        <h2 className="text-lg font-semibold tracking-tight">Compare roles</h2>
        <p className="mt-0.5 text-sm text-muted">Two roles side by side — cells where they differ are highlighted.</p>
        <div className="card mt-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 p-4">
          {select("a", a)}
          <span className="text-sm text-subtle">vs</span>
          {select("b", b)}
        </div>
        {roles.error && <p className="mt-4 text-sm text-warning">Couldn't read the roles: {roles.error}</p>}
        <div className="mt-5">
          {!ra || !rb ? (
            <p className="text-sm text-subtle">Pick two roles.</p>
          ) : error ? (
            <p className="text-sm text-warning">Couldn't read the privileges: {error}</p>
          ) : !matrix ? (
            <div className="flex items-center gap-2 text-sm text-subtle">
              <Loader size={14} className="text-brand" /> Reading privileges…
            </div>
          ) : (
            <PrivilegeMatrix matrix={matrix} sources={[ra.name, rb.name]} emptyText="No differences." />
          )}
        </div>
      </div>
    </div>
  );
}

function Empty({ icon, title, text }: { icon: React.ReactNode; title: string; text: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="empty-icon">{icon}</div>
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="mt-0.5 max-w-sm text-xs text-subtle">{text}</div>
      </div>
    </div>
  );
}
