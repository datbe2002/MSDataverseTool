// Shared types — must mirror the serde (camelCase) output of the Rust backend.

/** A tenant / customer workspace: one sign-in plus the environments under it. */
export interface Project {
  id: string;
  name: string;
  /** "" = the global default tenant, else a tenant GUID or domain. */
  tenant: string;
  clientId: string | null;
  /** The account this project is signed in as; null when signed out. */
  username: string | null;
  color: string | null;
  createdAt: string;
}

export interface Environment {
  id: string;
  friendlyName: string;
  url: string;
  apiUrl: string;
  urlName: string;
  version: string;
  state: string;
  host: string;
}

export interface Connection {
  id: string;
  /** Owning project. */
  projectId: string;
  name: string;
  url: string;
  host: string;
  apiUrl: string;
  friendlyName: string;
  lastUsed: string | null;
  /** Short label like "UAT" / "PROD" */
  tag: string | null;
  /** Palette key, see lib/tags.ts */
  color: string | null;
}

export interface ColumnInfo {
  name: string;
  dataType: string;
}

export type Cell = string | number | boolean | null;

export interface QueryResult {
  columns: ColumnInfo[];
  rows: Cell[][];
  rowCount: number;
  elapsedMs: number;
  truncated: boolean;
  /** "tds" | "fetchxml" — which path produced the rows */
  engine?: string;
  /** Why the query ran on that engine when it wasn't the first choice. */
  note?: string;
  /** Rows arrived as `query-page` events; `rows` here is empty. */
  streamed?: boolean;
  /** Long text cells were shortened for the grid; `api.resultRows` has them in full. */
  clipped?: boolean;
  /** The id the rows were streamed under (set by the store). */
  requestId?: string;
  timings?: Timings;
}

/** Where the backend spent its time (all in ms). */
export interface Timings {
  totalMs: number;
  connectMs?: number;
  execMs?: number;
  metadataMs?: number;
  /** Reading rows, wall clock. */
  fetchMs: number;
  /** HTTP requests for rows (FetchXML), key-scan requests included. */
  pages?: number;
  /** Bytes parsed (decompressed). */
  bytes?: number;
  /** Bytes over the network (gzip). */
  wireBytes?: number;
  /** Summed over requests: waiting for the server to answer … */
  waitMs?: number;
  /** … and downloading + parsing. */
  downloadMs?: number;
  /** Key-scan requests that planned the parallel reads. */
  keyPages?: number;
  /** Parallel requests allowed (1 = sequential paging). */
  threads?: number;
  /** Times the server said "slow down" (429/503). */
  throttled?: number;
}

/** One chunk of rows streamed while a query runs. */
export interface QueryPage {
  requestId: string;
  engine: string;
  columns: ColumnInfo[];
  rows: Cell[][];
}

/** How a SELECT runs: the FetchXML engine (TDS only when it can't plan the
 *  SQL), or the TDS endpoint only (Settings → Use TDS endpoint). */
export type EngineMode = "fetchxml" | "tds";

export interface TableMeta {
  logicalName: string;
  displayName: string;
  isCustom: boolean;
}

export interface ColumnMeta {
  logicalName: string;
  displayName: string;
  attributeType: string;
}

/** Choice columns of a table (`table_choices`), for labels next to option values. */
export interface TableChoices {
  /** Logical name (it may have been asked for by entity set name). */
  table: string;
  columns: Record<string, { value: number; label: string }[]>;
}

export type DmlKind = "update" | "delete" | "insert";

export interface DmlPreview {
  planId: string;
  kind: DmlKind;
  table: string;
  count: number;
  columns: string[];
}

export interface DmlProgress {
  done: number;
  total: number;
  /** Workers currently alive. */
  threads: number;
  /** Workers waiting out the server's Retry-After. */
  paused: number;
}

export interface DmlResult {
  kind: DmlKind;
  table: string;
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
  elapsedMs: number;
  /** Most workers that ran at the same time. */
  maxThreads: number;
  /** Times the server asked us to slow down (429 / 503). */
  throttled: number;
}

export interface Settings {
  clientId: string;
  tenant: string;
  /** Parallel requests for INSERT/UPDATE/DELETE; 0 = follow the server's x-ms-dop-hint. */
  workerThreads: number;
}

/** A Power Automate cloud flow (a `workflow` row with category 5). */
export interface FlowMeta {
  id: string;
  name: string;
  description: string | null;
  /** 0 = Draft (off), 1 = Activated (on), 2 = Suspended. */
  state: number;
  stateLabel: string;
  owner: string;
  modifiedBy: string;
  modifiedOn: string;
  createdOn: string;
  managed: boolean;
  /** Friendly names of the solutions containing the flow (empty if unknown). */
  solutions: string[];
}

export interface FlowList {
  flows: FlowMeta[];
  /** Set when solutions couldn't be read (e.g. no prvReadSolution). */
  solutionsError: string | null;
}

/** A "Run a Child Flow" call between two flows (lowercase `workflow` ids). */
export interface FlowCall {
  parent: string;
  child: string;
}
