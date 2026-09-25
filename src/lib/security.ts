// Security tool: users, roles and privileges per environment, the privilege
// matrix (table × action), and reading a record-access check.
import { api } from "../api";
import { createEnvCache } from "./envCache";
import type { AccessCheck, RolePrivilege, SecurityRole, SecurityUser, UserRoles } from "../types";

export const usersCache = createEnvCache<SecurityUser[]>((c) => api.securityUsers(c));
export const rolesCache = createEnvCache<SecurityRole[]>((c) => api.securityRoles(c));
export const userRolesCache = createEnvCache<UserRoles>((c, userId) => api.userRoles(c, userId));
export const privilegesCache = createEnvCache<RolePrivilege[]>((c, roleId) => api.rolePrivileges(c, roleId));

export const ACTIONS = ["Create", "Read", "Write", "Delete", "Append", "AppendTo", "Assign", "Share"] as const;
export type Action = (typeof ACTIONS)[number];

export const DEPTHS = ["None", "User", "Business unit", "Parent: child business units", "Organization"] as const;

/** "prvReadAccount" → { action: "Read", table: "account" }; other privileges → null. */
export function parsePrivilege(name: string): { action: Action; table: string } | null {
  const m = /^prv(Create|Read|Write|Delete|AppendTo|Append|Assign|Share)(.+)$/.exec(name);
  return m ? { action: m[1] as Action, table: m[2].toLowerCase() } : null;
}

/** Where a depth comes from: the role(s) that grant it. */
export interface Grant {
  depth: number;
  from: string[];
}

/** Privileges of several roles merged: the deepest wins, with every role that gives that depth. */
export function mergePrivileges(roles: { name: string; privileges: RolePrivilege[] }[]): Map<string, Grant> {
  const out = new Map<string, Grant>();
  for (const r of roles) {
    for (const p of r.privileges) {
      const g = out.get(p.name);
      if (!g || p.depth > g.depth) out.set(p.name, { depth: p.depth, from: [r.name] });
      else if (p.depth === g.depth && !g.from.includes(r.name)) g.from.push(r.name);
    }
  }
  return out;
}

export interface MatrixRow {
  table: string;
  label: string;
  /** One grant per source (one role, or two when comparing), per action. */
  cells: Record<Action, (Grant | undefined)[]>;
}

export interface Matrix {
  rows: MatrixRow[];
  /** Privileges that aren't table actions (prvExportToExcel…). */
  misc: { name: string; grants: (Grant | undefined)[] }[];
}

/** Table × action rows for one or more privilege sets (compare = two). */
export function buildMatrix(sources: Map<string, Grant>[], tableLabel: (t: string) => string | undefined): Matrix {
  const rows = new Map<string, MatrixRow>();
  const misc = new Map<string, (Grant | undefined)[]>();
  sources.forEach((src, i) => {
    for (const [name, grant] of src) {
      const p = parsePrivilege(name);
      if (!p) {
        const g = misc.get(name) ?? misc.set(name, sources.map(() => undefined)).get(name)!;
        g[i] = grant;
        continue;
      }
      let row = rows.get(p.table);
      if (!row) {
        row = {
          table: p.table,
          label: tableLabel(p.table) ?? p.table,
          cells: Object.fromEntries(ACTIONS.map((a) => [a, sources.map(() => undefined)])) as MatrixRow["cells"],
        };
        rows.set(p.table, row);
      }
      row.cells[p.action][i] = grant;
    }
  });
  return {
    rows: [...rows.values()].sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" })),
    misc: [...misc.entries()].map(([name, grants]) => ({ name, grants })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The roles of a user (their own and their teams'), named for the matrix tooltips. */
export function rolesOf(ur: UserRoles): { role: SecurityRole; via: string | null }[] {
  const out = ur.direct.map((role) => ({ role, via: null as string | null }));
  for (const t of ur.teams) for (const role of t.roles) out.push({ role, via: t.name });
  return out;
}

/** A record id from a GUID or a record URL (`…etn=account&id=…`); the table too when the URL has it. */
export function parseRecordRef(input: string): { id: string | null; table: string | null } {
  const s = input.trim();
  const guid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  let table: string | null = null;
  let id: string | null = null;
  try {
    const url = new URL(s);
    table = url.searchParams.get("etn");
    id = url.searchParams.get("id")?.match(guid)?.[0] ?? null;
  } catch {
    // Not a URL: a bare id.
  }
  id ??= s.match(guid)?.[0] ?? null;
  return { id: id?.toLowerCase() ?? null, table: table?.toLowerCase() ?? null };
}

export const RIGHTS: { right: string; action: Action; label: string }[] = [
  { right: "ReadAccess", action: "Read", label: "Read" },
  { right: "WriteAccess", action: "Write", label: "Write" },
  { right: "DeleteAccess", action: "Delete", label: "Delete" },
  { right: "AppendAccess", action: "Append", label: "Append" },
  { right: "AppendToAccess", action: "AppendTo", label: "Append to" },
  { right: "AssignAccess", action: "Assign", label: "Assign" },
  { right: "ShareAccess", action: "Share", label: "Share" },
];

export interface RightVerdict {
  label: string;
  has: boolean;
  /** Depth the user's roles give for this action on the table (0 = none). */
  depth: number;
  from: string[];
  /** Depth the record needs (0 = any, for organization-owned tables). */
  needed: number;
  why: string;
}

/** Which depth reaches the record from the user's point of view. */
export function neededDepth(check: AccessCheck, userId: string, teamIds: string[]): { depth: number; reason: string } {
  if (!check.ownerId) return { depth: 0, reason: "The table is organization-owned: any level of the privilege reaches every record." };
  const owner = check.ownerId.toLowerCase();
  if (owner === userId.toLowerCase()) return { depth: 1, reason: "The user owns the record." };
  if (check.ownerKind === "team" && teamIds.some((t) => t.toLowerCase() === owner))
    return { depth: 1, reason: `The record is owned by ${check.owner ?? "a team"}, and the user is on that team.` };
  const userBu = check.userBusinessUnitId?.toLowerCase();
  const recordBu = check.owningBusinessUnitId?.toLowerCase();
  if (userBu && recordBu === userBu) return { depth: 2, reason: `The record is in the user's business unit (${check.userBusinessUnit}).` };
  if (userBu && check.owningBusinessUnitParents.includes(userBu))
    return { depth: 3, reason: `The record is in ${check.owningBusinessUnit ?? "a business unit"}, below the user's (${check.userBusinessUnit}).` };
  return { depth: 4, reason: `The record is in ${check.owningBusinessUnit ?? "another business unit"}, outside the user's branch (${check.userBusinessUnit}).` };
}

export function verdicts(check: AccessCheck, table: string, effective: Map<string, Grant>, needed: number): RightVerdict[] {
  return RIGHTS.map(({ right, action, label }) => {
    const grant = [...effective.entries()].find(([name]) => {
      const p = parsePrivilege(name);
      return p?.table === table && p.action === action;
    })?.[1];
    const depth = grant?.depth ?? 0;
    const has = check.rights.includes(right);
    const enough = depth > 0 && depth >= needed;
    const why = has
      ? enough
        ? `Roles give ${DEPTHS[depth]} level.`
        : "Not from the roles — the record is shared with the user or one of their teams, or hierarchy security gives it."
      : depth === 0
      ? "No role gives this privilege on the table."
      : enough
      ? "The roles should allow it; check column security, the record's status or business unit access."
      : `Roles give ${DEPTHS[depth]} level; this record needs ${DEPTHS[needed]}.`;
    return { label, has, depth, from: grant?.from ?? [], needed, why };
  });
}
