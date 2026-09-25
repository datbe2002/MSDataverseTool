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

/** One page of a FetchXML query (`run_fetchxml`). */
export interface FetchPage {
  /** Rows as the Web API returned them, annotations included. */
  records: Record<string, unknown>[];
  moreRecords: boolean;
  /** For the next page's `paging-cookie` attribute (decoded, not XML-escaped). */
  pagingCookie: string | null;
  elapsedMs: number;
  /** Response size after decompression. */
  bytes: number;
  /** Times the server asked us to slow down (429 / 503). */
  throttled: number;
}

/** A way to join a table (`list_relationships`), as `<link-entity>` attributes. */
export interface Relationship {
  kind: "manyToOne" | "oneToMany" | "manyToMany";
  schemaName: string;
  /** Joined table (`name`); for N:N the table on the other side. */
  table: string;
  /** Column on `table` (`from`). */
  from: string;
  /** Column on the queried table (`to`); for N:N its key. */
  to: string;
  /** N:N: the intersect table, joined first (from = intersectFrom, to = to), then `table` (from = from, to = intersectTo). */
  intersect?: string;
  intersectFrom?: string;
  intersectTo?: string;
}

/** A saved view of a table (`list_views`): system (`savedquery`) or personal (`userquery`). */
export interface SavedView {
  id: string;
  name: string;
  personal: boolean;
  queryType: number;
  /** "Public", "Advanced Find", "Lookup", "Personal", … */
  typeLabel: string;
  isDefault: boolean;
  description?: string;
  fetchXml: string;
}

export interface ViewList {
  views: SavedView[];
  /** Personal views couldn't be read (system views still listed). */
  personalError: string | null;
}

/** A FetchXML file opened / saved on this computer. */
export interface XmlFile {
  path: string;
  name: string;
  /** Only when opening. */
  contents?: string;
}

/** A table's key and name columns (`table_keys`). */
export interface TableKeys {
  primaryId: string;
  primaryName: string | null;
}

/** Server-side filters of the plug-in trace log list (`trace_logs`). */
export interface TraceFilter {
  /** Created at or after (ISO). */
  since?: string | null;
  typeName?: string | null;
  message?: string | null;
  entity?: string | null;
  /** 0 = synchronous, 1 = asynchronous. */
  mode?: number | null;
  exceptionsOnly?: boolean;
  correlationId?: string | null;
  /** The trace text or the exception contains this. */
  text?: string | null;
  minDurationMs?: number | null;
}

/** A `plugintracelog` row as the list shows it. */
export interface TraceRow {
  id: string;
  typeName: string;
  message: string;
  entity: string;
  mode: number;
  modeLabel: string;
  /** 1 = plug-in, 2 = workflow activity. */
  operationType: number;
  operationLabel: string;
  depth: number;
  createdOn: string;
  durationMs: number | null;
  correlationId: string | null;
  requestId: string | null;
  stepId: string | null;
  /** Gist of the exception when the run threw. */
  exception: string | null;
}

export interface TracePage {
  rows: TraceRow[];
  /** Link for the next page (pass back as `next`). */
  next: string | null;
  /** "Enable logging to plug-in trace log": 0 off, 1 exceptions, 2 all (first page only). */
  logging: number | null;
}

export interface TraceDetail extends TraceRow {
  messageBlock: string;
  exceptionDetails: string;
  configuration: string;
  createdBy: string;
  constructorMs: number | null;
  executionStart: string;
  systemCreated: boolean;
}

/** Server-side filters of the system job list (`system_jobs`). */
export interface JobFilter {
  since?: string | null;
  name?: string | null;
  status?: JobStatusFilter | null;
  operationType?: number | null;
  entity?: string | null;
  text?: string | null;
  correlationId?: string | null;
  regardingId?: string | null;
}

export type JobStatusFilter = "failed" | "waiting" | "queued" | "inprogress" | "succeeded" | "canceled";

/** An `asyncoperation` row as the list shows it. */
export interface JobRow {
  id: string;
  name: string;
  operationType: number;
  operationLabel: string;
  /** 0 Ready, 1 Suspended, 2 Locked, 3 Completed. */
  state: number;
  /** 0 Waiting for resources, 10 Waiting, 20 In progress, 21 Pausing, 22 Canceling, 30 Succeeded, 31 Failed, 32 Canceled. */
  status: number;
  statusLabel: string;
  createdOn: string;
  startedOn: string | null;
  completedOn: string | null;
  postponeUntil: string | null;
  entity: string;
  messageName: string;
  regardingId: string | null;
  regardingTable: string | null;
  regardingName: string | null;
  owner: string;
  process: string | null;
  depth: number;
  retryCount: number;
  errorCode: number | null;
  correlationId: string | null;
  requestId: string | null;
  stage: string | null;
  /** Gist of the error message (failed / canceled jobs). */
  error: string | null;
}

export interface JobPage {
  rows: JobRow[];
  next: string | null;
}

export interface JobDetail extends JobRow {
  message: string;
  friendlyMessage: string;
  createdBy: string;
}

/* ---------- Plug-in registrations (read only) ---------- */

export interface PluginAssembly {
  id: string;
  name: string;
  version: string;
  /** "Sandbox" / "None" / "External". */
  isolation: string;
  managed: boolean;
  modifiedOn: string;
  description: string | null;
}

export interface PluginType {
  id: string;
  assemblyId: string;
  typeName: string;
  isWorkflowActivity: boolean;
}

export interface PluginEndpoint {
  id: string;
  name: string;
  /** "Webhook", "Queue", "Topic"… */
  contract: string;
}

/** A step in the slim index: enough to count and place it. */
export interface StepRef {
  id: string;
  handler: string | null;
  /** "none" for messages without a table. */
  table: string;
  enabled: boolean;
}

export interface PluginOverview {
  assemblies: PluginAssembly[];
  types: PluginType[];
  endpoints: PluginEndpoint[];
  steps: StepRef[];
  endpointsError: string | null;
}

export interface PluginStep {
  id: string;
  name: string;
  description: string | null;
  handlerId: string | null;
  /** "plugintype" | "serviceendpoint" */
  handlerKind: string | null;
  handlerName: string | null;
  message: string;
  /** "none" for messages without a table. */
  table: string;
  secondaryTable: string | null;
  /** 10 Pre-validation, 20 Pre-operation, 30 Main operation, 40 Post-operation. */
  stage: number;
  stageLabel: string;
  /** 0 synchronous, 1 asynchronous. */
  mode: number;
  rank: number;
  enabled: boolean;
  filteringAttributes: string[];
  /** Only in a step's detail. */
  configuration: string | null;
  runAs: string | null;
  asyncAutoDelete: boolean;
  deployment: string;
  managed: boolean;
  modifiedOn: string;
}

export interface PluginStepImage {
  id: string;
  stepId: string;
  name: string;
  alias: string;
  /** 0 Pre, 1 Post, 2 Both. */
  imageType: number;
  attributes: string[];
  messageProperty: string;
}

export interface PluginStepDetail {
  step: PluginStep;
  images: PluginStepImage[];
  /** The assembly of the step's plug-in type. */
  assemblyId: string | null;
}

/** Which steps to list: one handler's, one table's, or those whose name contains `search`. */
export interface StepQuery {
  handler?: string | null;
  table?: string | null;
  search?: string | null;
}

/* ---------- Dependencies ---------- */

export interface DependencyItem {
  kind: number;
  kindLabel: string;
  id: string;
  name: string;
  detail: string | null;
  table: string | null;
  /** 1 Solution internal, 2 Published, 4 Unpublished. */
  dependencyType: number;
}

export interface StepUse {
  stepId: string;
  stepName: string;
  message: string;
  stageLabel: string;
  enabled: boolean;
  how: string;
}

export interface DependencyReport {
  target: string;
  items: DependencyItem[];
  steps: StepUse[];
  stepsError: string | null;
}

export interface FlowMention {
  id: string;
  name: string;
  hits: number;
}

/* ---------- Security ---------- */

export interface SecurityUser {
  id: string;
  name: string;
  email: string | null;
  username: string | null;
  title: string | null;
  disabled: boolean;
  accessMode: number;
  accessModeLabel: string;
  application: boolean;
  businessUnit: string;
  businessUnitId: string | null;
}

export interface SecurityRole {
  id: string;
  rootId: string;
  name: string;
  businessUnit: string;
  managed: boolean;
}

export interface TeamRoles {
  id: string;
  name: string;
  teamType: string;
  roles: SecurityRole[];
  error: string | null;
}

export interface UserRoles {
  businessUnit: string;
  businessUnitId: string | null;
  direct: SecurityRole[];
  teams: TeamRoles[];
}

export interface RolePrivilege {
  name: string;
  /** 1 User, 2 Business unit, 3 Parent: child BUs, 4 Organization. */
  depth: number;
}

export interface AccessCheck {
  rights: string[];
  recordName: string | null;
  ownership: string;
  owner: string | null;
  ownerId: string | null;
  ownerKind: string | null;
  owningBusinessUnit: string | null;
  owningBusinessUnitId: string | null;
  userBusinessUnit: string;
  userBusinessUnitId: string | null;
  userBusinessUnitParents: string[];
  owningBusinessUnitParents: string[];
}
