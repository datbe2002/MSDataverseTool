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
  /** Web API collection (`accounts`); empty when the Web API can't read the table. */
  entitySetName: string;
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

/** The environment a flow task works on. */
export interface TaskEnv {
  host: string;
  name: string;
}

/** A flow checked out into a task (`task.json`). */
export interface TaskFlow {
  /** `workflow` id, lowercase. */
  id: string;
  name: string;
  /** Folder under `flows/`. */
  folder: string;
  addedOn: string;
  /** The flow's `modifiedon` when it was added. */
  cloudModifiedOn: string;
  cloudModifiedBy: string;
  baselineHash: string;
  /** Hash of the working version marked as reviewed. */
  reviewedHash: string | null;
  /** When the baseline was read from the cloud again; null = when added. */
  baselineOn: string | null;
}

export interface TaskFile {
  version: number;
  id: string;
  name: string;
  ticket: string;
  description: string;
  env: TaskEnv;
  createdOn: string;
  status: "open" | "done";
  flows: TaskFlow[];
}

/** A task in the list of task folders. */
export interface TaskSummary {
  path: string;
  id: string;
  name: string;
  env: TaskEnv | null;
  status: "open" | "done";
  flowIds: string[];
  createdOn: string;
  lastOpened: string;
  /** The folder or its task.json is gone. */
  missing: boolean;
}

/** A task flow's file on disk now. */
export interface TaskFlowFile {
  id: string;
  /** Relative to the task folder, e.g. `flows/Invoice-Sync__3f2a9c1e/definition.json`. */
  file: string;
  /** Hash of the JSON (keys sorted, no whitespace); null when missing or not JSON. */
  workingHash: string | null;
  error: string | null;
  modifiedAt: string | null;
}

export interface TaskView {
  path: string;
  task: TaskFile;
  git: { available: boolean; repo: boolean };
  flows: TaskFlowFile[];
  /** Set by a change when something besides it failed (a git commit). */
  warning: string | null;
}

/** Where a new task folder would go. */
export interface TaskLocation {
  path: string;
  problem: string | null;
  exists: boolean;
  notEmpty: boolean;
  insideRepo: string | null;
  oneDrive: boolean;
  gitAvailable: boolean;
}

export interface NewFlowTask {
  parent: string;
  folder: string;
  name: string;
  ticket: string;
  description: string;
  env: TaskEnv;
  git: boolean;
}

/** An earlier version of a task flow's file: `git:<sha>` or `snap:<file>`. */
export interface TaskVersion {
  id: string;
  label: string;
  at: string;
}

/** A task flow as it is in the environment now. */
export interface LiveTaskFlow {
  id: string;
  name: string;
  content: string | null;
  hash: string | null;
  modifiedOn: string;
  modifiedBy: string;
  error: string | null;
}

/** What a flow run ended as, whatever its `status` spelling. */
export type RunOutcome = "failed" | "succeeded" | "cancelled" | "running" | "other";

/** Server-side filters of the flow run list (`flow_runs`). */
export interface RunFilter {
  since?: string | null;
  /** Only runs started before this time. */
  until?: string | null;
  /** One flow's runs (its `workflow` id). */
  flowId?: string | null;
  status?: Exclude<RunOutcome, "other"> | null;
  /** One run by its name (finds a child run's parent). */
  runName?: string | null;
  /** The runs this run started (child flows). */
  parentRun?: string | null;
  /** Runs with this error code; "" = runs without one. */
  errorCode?: string | null;
}

/** A cloud flow run (`flowrun` row). */
export interface RunRow {
  id: string;
  /** The run id Power Automate shows (`08584…CU12`). */
  runName: string;
  /** Lowercase `workflow` id. */
  flowId: string | null;
  flowName: string | null;
  status: string;
  outcome: RunOutcome;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  triggerType: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  parentRunId: string | null;
  owner: string;
}

export interface RunPage {
  rows: RunRow[];
  next: string | null;
}

/** One flow's runs in a summary window. */
export interface FlowRunStats {
  /** Lowercase `workflow` id ("" when the run didn't name its flow). */
  flowId: string;
  total: number;
  failed: number;
  succeeded: number;
  cancelled: number;
  running: number;
  lastRun: string | null;
  lastFailure: string | null;
  lastErrorCode: string | null;
}

/** Failed runs of one error code in a summary window. */
export interface ErrorStats {
  /** As stored; "" for failures without one. */
  code: string;
  failed: number;
  /** Lowercase `workflow` ids, most failures first. */
  flows: { flowId: string; failed: number }[];
  firstSeen: string | null;
  lastSeen: string | null;
  /** Hours with failures of this code (UTC hour start), oldest first. */
  hours: { at: string; failed: number }[];
}

/** Runs and failures of every flow since a time (`flow_run_summary`). */
/** A trigger, an action, or one repetition of an action in a loop (Power Automate API). */
export interface RunStep {
  /** The step's name in the definition (`Get_items`); a repetition's own name for repetitions. */
  name: string;
  status: string;
  code: string | null;
  startTime: string | null;
  endTime: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Signed links to the inputs / outputs (`flowRunContent`). */
  inputsLink: string | null;
  inputsSize: number | null;
  outputsLink: string | null;
  outputsSize: number | null;
  /** How many times it ran, for a step inside a loop. */
  repetitionCount: number | null;
  /** Which loop items a repetition ran for, outermost first. */
  repetition: { scopeName: string; itemIndex: number }[];
}

export interface RunSteps {
  trigger: RunStep | null;
  actions: RunStep[];
  /** Too many actions: the rest weren't read. */
  truncated: boolean;
}

/** Which steps a run search reads: `steps` null = every step. */
export interface RunSearchScope {
  steps: string[] | null;
  /** With `steps`: the trigger's outputs too. */
  trigger: boolean;
}

/** Where a searched value was found in a run. */
export interface RunSearchHit {
  /** The step's name in the definition. */
  step: string;
  part: "inputs" | "outputs";
  repetition: { scopeName: string; itemIndex: number }[];
  /** The text around the match, on one line. */
  snippet: string;
}

/** A step's inputs or outputs. */
export interface RunStepContent {
  text: string;
  truncated: boolean;
}

/** prvReadflowrun depth; "basic" sees only runs of flows the account owns. */
export type RunReadDepth = "none" | "basic" | "local" | "deep" | "global";

export interface RunSummary {
  since: string;
  until: string;
  total: number;
  failed: number;
  succeeded: number;
  cancelled: number;
  running: number;
  /** Most failures first. */
  flows: FlowRunStats[];
  /** Hours with runs (UTC hour start), oldest first. */
  hours: { at: string; total: number; failed: number }[];
  /** Failures grouped by error code, most first. */
  errors: ErrorStats[];
  /** Stopped reading at the row cap: counts are a lower bound. */
  truncated: boolean;
  /** How long the environment keeps runs; null if unknown. */
  retentionSeconds: number | null;
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

/** A file the app saved for the user (exported rows, a web resource). */
export interface XmlFile {
  path: string;
  name: string;
  /** Only when opening. */
  contents?: string;
}

/** A read-only Web API request's answer (`webapi_get`); HTTP errors arrive here too. */
export interface ApiResponse {
  status: number;
  ok: boolean;
  /** The URL sent, percent-encoded. */
  url: string;
  /** JSON body; null when empty or not JSON. */
  body: unknown;
  /** The body when it wasn't JSON. */
  text?: string;
  elapsedMs: number;
  bytes: number;
  throttled: number;
}

/** A column as the REST builder sees it (`rest_table`). */
export interface RestColumn {
  logicalName: string;
  displayName: string;
  attributeType: string;
  /** `AttributeTypeName`, e.g. "MultiSelectPicklistType", "FileType". */
  typeName: string;
  /** Set on columns that belong to another (`owneridname` → `ownerid`). */
  attributeOf?: string;
  readable: boolean;
  creatable: boolean;
  updatable: boolean;
  /** Tables a lookup can point at. */
  targets?: string[];
}

/** A navigation property: `$expand`, `@odata.bind`, associate. */
export interface NavProperty {
  name: string;
  /** "single" = this table's lookup (N:1); "collection" = 1:N or N:N. */
  kind: "single" | "collection";
  relationship: "manyToOne" | "oneToMany" | "manyToMany";
  schemaName: string;
  /** The table on the other side. */
  table: string;
  /** N:1: this table's lookup column; 1:N: the other table's. */
  column?: string;
}

export interface RestTable {
  logicalName: string;
  displayName: string;
  collectionDisplayName: string;
  entitySet: string;
  primaryId: string;
  primaryName: string | null;
  columns: RestColumn[];
  navigation: NavProperty[];
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

/* ---------- Desktop flows (RPA, read only) ---------- */

/** A desktop flow (`workflow` with category 6). */
export interface DesktopFlow {
  id: string;
  name: string;
  description: string;
  /** 0 Draft, 1 Activated, 2 Suspended. */
  state: number;
  stateLabel: string;
  /** e.g. "Power Automate Desktop", "Selenium IDE". */
  kind: string | null;
  managed: boolean;
  owner: string;
  modifiedOn: string;
  modifiedBy: string;
  createdOn: string;
}

/** An input or output variable of a desktop flow. */
export interface DesktopFlowParam {
  name: string;
  kind: string;
  description: string;
  default: string | null;
  sensitive: boolean;
}

export interface DesktopFlowDetail {
  inputs: DesktopFlowParam[];
  outputs: DesktopFlowParam[];
  schemaError: string | null;
}

export type DesktopRunStatusFilter = "failed" | "running" | "waiting" | "succeeded" | "canceled";

/** Server-side filters of the desktop flow run list (`desktop_flow_runs`). */
export interface DesktopRunFilter {
  since?: string | null;
  status?: DesktopRunStatusFilter | null;
  flowId?: string | null;
  machineId?: string | null;
  groupId?: string | null;
  /** 0 Local, 1 Attended, 2 Unattended. */
  runMode?: number | null;
  text?: string | null;
  /** Only the newest `top` runs. */
  top?: number | null;
}

/** A `flowsession` row as the list shows it. */
export interface DesktopRun {
  id: string;
  name: string;
  /** 1 Paused, 2 Running, 3 Waiting, 4 Succeeded, 5 Skipped, 6 Suspended, 7 Cancelled, 8 Failed, 9 Faulted, 10 Timed out, 11 Aborted… */
  status: number;
  statusLabel: string;
  state: number;
  createdOn: string;
  startedOn: string | null;
  completedOn: string | null;
  runMode: number | null;
  runModeLabel: string | null;
  trigger: string | null;
  test: boolean;
  flowId: string | null;
  flowName: string | null;
  machineId: string | null;
  machineName: string | null;
  groupId: string | null;
  groupName: string | null;
  owner: string;
  sessionUser: string | null;
  processVersion: string | null;
  errorCode: string | null;
  /** First line of the error message. */
  error: string | null;
  parentCloudRun: string | null;
  parentFlowId: string | null;
  parentDesktopRun: string | null;
  correlationId: string | null;
  connectionId: string | null;
}

export interface DesktopRunPage {
  rows: DesktopRun[];
  next: string | null;
}

export interface DesktopRunDetail extends DesktopRun {
  errorMessage: string;
  errorDetails: string;
  runDetails: string;
  inputs: string | null;
  outputs: string | null;
  filesError: string | null;
  createdBy: string;
}

export interface FlowMachine {
  id: string;
  name: string;
  description: string;
  /** 0 Active, 1 Inactive, 2 Maintenance. */
  state: number;
  status: number;
  statusLabel: string;
  agentVersion: string | null;
  lastHeartbeat: string | null;
  hosting: string | null;
  sessionCapacity: number | null;
  groupId: string | null;
  owner: string;
  createdOn: string;
}

export interface FlowMachineGroup {
  id: string;
  name: string;
  description: string;
  state: number;
  statusLabel: string;
  /** The hidden group behind a standalone machine. */
  implicit: boolean;
  lastRun: string | null;
  owner: string;
  createdOn: string;
}

export interface FlowMachineList {
  machines: FlowMachine[];
  groups: FlowMachineGroup[];
  groupsError: string | null;
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

/* ---------- Web resources ---------- */

export interface WebResource {
  id: string;
  /** Unique name, often a path: `new_/scripts/account.js`. */
  name: string;
  displayName: string;
  description: string | null;
  /** 1 HTML · 2 CSS · 3 JS · 4 XML · 5 PNG · 6 JPG · 7 GIF · 8 XAP · 9 XSL · 10 ICO · 11 SVG · 12 RESX. */
  kind: number;
  managed: boolean;
  modifiedOn: string;
  modifiedBy: string | null;
  solutions: string[];
  /** Shipped by Microsoft (a Dynamics 365 app, the platform…). */
  microsoft: boolean;
}

export interface WebResourceSolution {
  id: string;
  uniqueName: string;
  friendlyName: string;
  managed: boolean;
  publisher: string;
  prefix: string;
  microsoft: boolean;
  /** Visible web resources in it. */
  count: number;
}

export interface WebResourceList {
  items: WebResource[];
  /** Every visible solution (count 0 = none of the web resources). */
  solutions: WebResourceSolution[];
  solutionsError: string | null;
  /** Largest file the environment takes (bytes). */
  maxUploadSize: number | null;
}

export interface WebResourceDetail {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  kind: number;
  managed: boolean;
  customizable: boolean;
  canBeDeleted: boolean;
  language: number | null;
  introducedVersion: string | null;
  createdOn: string;
  createdBy: string | null;
  modifiedOn: string;
  modifiedBy: string | null;
  /** Published content, base64. */
  content: string;
  size: number;
  /** Saved-but-not-published content (base64), only when it differs. */
  unpublished: string | null;
  unpublishedSize: number | null;
  unpublishedError: string | null;
  etag: string | null;
  /** Hash of the latest content; a save sends it back to catch someone else's save. */
  latestHash: string;
}

export interface NewWebResource {
  /** Full unique name, prefix included. */
  name: string;
  displayName: string;
  description: string | null;
  kind: number;
  /** Base64, may be empty. */
  content: string;
  /** Solution unique name; null = default solution only. */
  solution: string | null;
}

export interface PickedFile {
  name: string;
  path: string;
  /** Base64. */
  content: string;
  size: number;
}
