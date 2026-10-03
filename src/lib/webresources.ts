// Web resources tool: the list per environment, one resource's content, what
// uses it; a folder tree built from the names; unsaved edits (drafts) and what
// was saved but not published yet.
import { create } from "zustand";
import { api } from "../api";
import { createEnvCache } from "./envCache";
import type { WebResource } from "../types";

/** The list (no content) and the solutions it's in; key "". */
export const listCache = createEnvCache((connId) => api.webResources(connId));
/** One resource with its published / unpublished content; key = id. */
export const detailCache = createEnvCache((connId, id) => api.webResource(connId, id));
/** What uses a resource; key = id. */
export const dependentsCache = createEnvCache((connId, id) => api.webResourceDependents(connId, id));

export interface KindInfo {
  label: string;
  /** Three letters for the tree. */
  tag: string;
  /** Monaco language, or null when it's shown as an image / not at all. */
  language: string | null;
  ext: string;
  mime: string;
  image: boolean;
  group: KindGroup;
}

export type KindGroup = "script" | "page" | "style" | "data" | "image" | "other";

export const KINDS: Record<number, KindInfo> = {
  1: { label: "HTML", tag: "htm", language: "html", ext: "html", mime: "text/html", image: false, group: "page" },
  2: { label: "CSS", tag: "css", language: "css", ext: "css", mime: "text/css", image: false, group: "style" },
  3: { label: "JavaScript", tag: "js", language: "javascript", ext: "js", mime: "text/javascript", image: false, group: "script" },
  4: { label: "XML", tag: "xml", language: "xml", ext: "xml", mime: "text/xml", image: false, group: "data" },
  5: { label: "PNG", tag: "png", language: null, ext: "png", mime: "image/png", image: true, group: "image" },
  6: { label: "JPG", tag: "jpg", language: null, ext: "jpg", mime: "image/jpeg", image: true, group: "image" },
  7: { label: "GIF", tag: "gif", language: null, ext: "gif", mime: "image/gif", image: true, group: "image" },
  8: { label: "Silverlight (XAP)", tag: "xap", language: null, ext: "xap", mime: "application/octet-stream", image: false, group: "other" },
  9: { label: "XSL", tag: "xsl", language: "xml", ext: "xsl", mime: "text/xml", image: false, group: "data" },
  10: { label: "ICO", tag: "ico", language: null, ext: "ico", mime: "image/x-icon", image: true, group: "image" },
  11: { label: "SVG", tag: "svg", language: "xml", ext: "svg", mime: "image/svg+xml", image: true, group: "image" },
  12: { label: "String (RESX)", tag: "rsx", language: "xml", ext: "resx", mime: "text/xml", image: false, group: "data" },
};

const UNKNOWN: KindInfo = { label: "Unknown", tag: "?", language: "plaintext", ext: "", mime: "application/octet-stream", image: false, group: "other" };

export const kindOf = (kind: number): KindInfo => KINDS[kind] ?? UNKNOWN;

export const GROUPS: { id: KindGroup | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "script", label: "JS" },
  { id: "page", label: "HTML" },
  { id: "style", label: "CSS" },
  { id: "image", label: "Images" },
  { id: "data", label: "XML / RESX" },
];

export interface Filters {
  q: string;
  group: KindGroup | "all";
  /** Solution friendly name, "" = any. */
  solution: string;
  hideMicrosoft: boolean;
}

export function matches(r: WebResource, f: Filters): boolean {
  if (f.hideMicrosoft && r.microsoft) return false;
  if (f.group !== "all" && kindOf(r.kind).group !== f.group) return false;
  if (f.solution && !r.solutions.includes(f.solution)) return false;
  const q = f.q.trim().toLowerCase();
  if (!q) return true;
  const hay = `${r.name} ${r.displayName} ${r.id}`.toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

/** Last path segment of a name: `new_/scripts/account.js` → `account.js`. */
export const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1) || name;

/** A file name to save as, with the type's extension when the name has none. */
export function fileNameFor(r: { name: string; kind: number }): string {
  const base = baseName(r.name);
  const ext = kindOf(r.kind).ext;
  return !ext || /\.[a-z0-9]{1,6}$/i.test(base) ? base : `${base}.${ext}`;
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface DecodedText {
  text: string;
  bom: boolean;
  crlf: boolean;
}

/** Text content as UTF-8 (what Dataverse stores), noting a BOM and CRLF line ends. */
export function decodeText(b64: string): DecodedText {
  const bytes = base64ToBytes(b64);
  const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const text = new TextDecoder("utf-8").decode(bom ? bytes.subarray(3) : bytes);
  return { text, bom, crlf: text.includes("\r\n") };
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- folder tree ---------- */

export interface Folder {
  /** "new_/scripts" — also its key (`dir:<path>`). */
  path: string;
  name: string;
  folders: Folder[];
  files: WebResource[];
  /** Files anywhere below. */
  count: number;
}

/** Folders from the `/` in names; folders first, then files, by name. */
export function buildTree(items: WebResource[]): Folder {
  const root: Folder = { path: "", name: "", folders: [], files: [], count: 0 };
  const index = new Map<string, Folder>([["", root]]);
  for (const r of items) {
    const parts = r.name.split("/").filter(Boolean);
    let parent = root;
    parent.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join("/");
      let f = index.get(path.toLowerCase());
      if (!f) {
        f = { path, name: parts[i], folders: [], files: [], count: 0 };
        index.set(path.toLowerCase(), f);
        parent.folders.push(f);
      }
      f.count++;
      parent = f;
    }
    parent.files.push(r);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    f.files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

/** Folder keys above a resource: `dir:new_`, `dir:new_/scripts`. */
export function foldersOf(name: string): string[] {
  const parts = name.split("/").filter(Boolean);
  return parts.slice(0, -1).map((_, i) => `dir:${parts.slice(0, i + 1).join("/")}`);
}

export type TreeRow =
  | { type: "folder"; key: string; folder: Folder; depth: number; open: boolean }
  | { type: "file"; key: string; item: WebResource; depth: number };

/** Rows on screen, given the open folders. */
export function visibleRows(root: Folder, open: Set<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (f: Folder, depth: number) => {
    for (const sub of f.folders) {
      const key = `dir:${sub.path}`;
      const isOpen = open.has(key);
      out.push({ type: "folder", key, folder: sub, depth, open: isOpen });
      if (isOpen) walk(sub, depth + 1);
    }
    for (const item of f.files) out.push({ type: "file", key: item.id, item, depth });
  };
  walk(root, 0);
  return out;
}

/** Every folder key, for Expand all. */
export function allFolders(root: Folder): string[] {
  const out: string[] = [];
  const walk = (f: Folder) => f.folders.forEach((s) => (out.push(`dir:${s.path}`), walk(s)));
  walk(root);
  return out;
}

/* ---------- editing (Phase 2) ---------- */

/** Dispatched on `window` by Ctrl+S (detail: `{ publish }` — Ctrl+Shift+S saves and publishes). */
export const WR_SAVE_EVENT = "hexa:webresource-save";

/** Unsaved changes to one web resource. */
export interface Draft {
  /** Edited text (text types). */
  text?: string;
  /** Replacement content from a file (base64), any type. */
  b64?: string;
  /** The file it came from, when replaced from a file. */
  fileName?: string;
  /** Hash of the server content the edit started from (to catch someone else's save). */
  baseHash: string;
  /** The text had a UTF-8 BOM: keep it. */
  bom: boolean;
}

interface EditState {
  /** Key `${connId}|${id}`. Kept while the app runs (not across restarts). */
  drafts: Record<string, Draft>;
  /** Saved this session but not published yet, per environment. */
  pending: Record<string, string[]>;
}

export const useWrEdits = create<EditState>(() => ({ drafts: {}, pending: {} }));

export const draftKey = (connId: string, id: string) => `${connId}|${id.toLowerCase()}`;

export function setDraft(connId: string, id: string, draft: Draft | null) {
  const k = draftKey(connId, id);
  useWrEdits.setState((s) => {
    const drafts = { ...s.drafts };
    if (draft) drafts[k] = draft;
    else delete drafts[k];
    return { drafts };
  });
}

/**
 * The editor's text: merged into the draft as it is now (a base changed by
 * Compare must survive), a new draft on `base`, or none when it's back to `original`.
 */
export function editDraftText(connId: string, id: string, text: string, original: string, base: Omit<Draft, "text" | "b64">) {
  const k = draftKey(connId, id);
  const now = useWrEdits.getState().drafts[k];
  if (text === original && !now?.fileName) setDraft(connId, id, null);
  else setDraft(connId, id, { ...(now ?? base), b64: undefined, text });
}

/** Adds (`on`) or removes web resources from the "saved, not published" list. */
export function markPending(connId: string, ids: string[], on: boolean) {
  const lower = ids.map((i) => i.toLowerCase());
  useWrEdits.setState((s) => {
    const now = s.pending[connId] ?? [];
    const next = on ? [...now, ...lower.filter((i) => !now.includes(i))] : now.filter((i) => !lower.includes(i));
    return { pending: { ...s.pending, [connId]: next } };
  });
}

/** Ids with a draft in this environment. */
export function draftIds(drafts: Record<string, Draft>, connId: string): string[] {
  const prefix = `${connId}|`;
  return Object.keys(drafts)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Text as UTF-8 base64, with a BOM when the original had one. */
export function encodeText(text: string, bom: boolean): string {
  const body = new TextEncoder().encode(text);
  if (!bom) return bytesToBase64(body);
  const out = new Uint8Array(body.length + 3);
  out.set([0xef, 0xbb, 0xbf]);
  out.set(body, 3);
  return bytesToBase64(out);
}

/** What a draft saves (base64). */
export const draftContent = (d: Draft) => d.b64 ?? encodeText(d.text ?? "", d.bom);

/** Decoded size of a draft. */
export const draftSize = (d: Draft) => (d.b64 !== undefined ? base64ToBytes(d.b64).length : new TextEncoder().encode(d.text ?? "").length + (d.bom ? 3 : 0));

const BY_EXT: Record<string, number> = { html: 1, htm: 1, css: 2, js: 3, xml: 4, png: 5, jpg: 6, jpeg: 6, gif: 7, xsl: 9, xslt: 9, ico: 10, svg: 11, resx: 12 };

/** The web resource type a file name suggests. */
export function kindFromName(name: string): number | null {
  const m = /\.([a-z0-9]+)$/i.exec(name);
  return m ? BY_EXT[m[1].toLowerCase()] ?? null : null;
}

/** Same rules as the backend (`name_problem`). */
export function nameProblem(name: string): string | null {
  if (!name) return "Enter a name.";
  if (name.length > 256) return "The name is longer than 256 characters.";
  if (!/^[A-Za-z0-9_./-]+$/.test(name)) return "Use only letters, numbers, _ . - and /.";
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//") || name.includes("..")) return "Folder names can't be empty, and “..” isn't allowed.";
  if (!name.includes("_")) return "Start the name with the publisher prefix and an underscore (contoso_…).";
  return null;
}

/** A save refused because someone else saved the web resource meanwhile. */
export const isConflict = (e: unknown) => String(e).includes("CONFLICT:");
