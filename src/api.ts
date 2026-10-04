import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { withReauth } from "./lib/reauth";
import type {
  AccessCheck,
  DependencyItem,
  DependencyReport,
  FlowMention,
  PluginOverview,
  PluginStep,
  PluginStepDetail,
  StepQuery,
  RolePrivilege,
  SecurityRole,
  SecurityUser,
  UserRoles,
  WebResourceDetail,
  WebResourceList,
  NewWebResource,
  PickedFile,
  Cell,
  ColumnMeta,
  Connection,
  DmlPreview,
  DmlResult,
  EngineMode,
  Environment,
  FetchPage,
  FlowCall,
  RunFilter,
  RunPage,
  RunSummary,
  RunReadDepth,
  FlowList,
  LiveTaskFlow,
  NewFlowTask,
  TaskLocation,
  TaskSummary,
  TaskVersion,
  TaskView,
  JobDetail,
  JobFilter,
  JobPage,
  Project,
  QueryResult,
  Relationship,
  Settings,
  TableChoices,
  TableKeys,
  TableMeta,
  TraceDetail,
  TraceFilter,
  TracePage,
  ViewList,
  XmlFile,
} from "./types";

/** A command; when its sign-in has expired, it waits for the user to sign in again and reruns. */
const invoke = <T>(cmd: string, args?: InvokeArgs) => withReauth(() => tauriInvoke<T>(cmd, args));

export const api = {
  listProjects: () => invoke<Project[]>("list_projects"),
  createProject: (
    name: string,
    tenant: string | null,
    clientId: string | null,
    color: string | null
  ) => invoke<Project>("create_project", { name, tenant, clientId, color }),
  updateProject: (
    id: string,
    name: string,
    tenant: string | null,
    clientId: string | null,
    color: string | null
  ) => invoke<Project>("update_project", { id, name, tenant, clientId, color }),
  /** Returns the ids of the connections that were removed with the project. */
  deleteProject: (id: string) => invoke<string[]>("delete_project", { id }),

  signIn: (projectId: string) => invoke<Project>("sign_in", { projectId }),
  signOut: (projectId: string) => invoke<void>("sign_out", { projectId }),
  /** Stops a sign-in waiting for the browser; the waiting call rejects with "Sign-in was cancelled". */
  cancelSignIn: () => invoke<void>("cancel_sign_in"),

  listEnvironments: (projectId: string) =>
    invoke<Environment[]>("list_environments", { projectId }),

  listConnections: () => invoke<Connection[]>("list_connections"),
  saveConnection: (projectId: string, url: string, name: string) =>
    invoke<Connection>("save_connection", { projectId, url, name }),
  updateConnection: (id: string, name: string, tag: string | null, color: string | null) =>
    invoke<Connection>("update_connection", { id, name, tag, color }),
  deleteConnection: (id: string) =>
    invoke<void>("delete_connection", { id }),

  /** With `requestId`, rows arrive as `query-page` events and the result's `rows` is empty. */
  runQuery: (connectionId: string, sql: string, maxRows: number, engine: EngineMode, requestId: string) =>
    invoke<QueryResult>("run_query", { connectionId, sql, maxRows, engine, requestId }),
  /** Full rows of a recent `clipped` result (the grid got long text shortened). */
  resultRows: (requestId: string) => invoke<Cell[][]>("result_rows", { requestId }),

  prepareDml: (connectionId: string, sql: string) =>
    invoke<DmlPreview>("prepare_dml", { connectionId, sql }),
  executeDml: (planId: string) => invoke<DmlResult>("execute_dml", { planId }),
  discardDml: (planId: string) => invoke<void>("discard_dml", { planId }),

  listTables: (connectionId: string) =>
    invoke<TableMeta[]>("list_tables", { connectionId }),
  listColumns: (connectionId: string, table: string) =>
    invoke<ColumnMeta[]>("list_columns", { connectionId, table }),
  /** `table`: logical name or entity set name. */
  tableChoices: (connectionId: string, table: string) =>
    invoke<TableChoices>("table_choices", { connectionId, table }),

  listFlows: (connectionId: string) => invoke<FlowList>("list_flows", { connectionId }),
  /** The flow's definition JSON (`clientdata`), pretty-printed. */
  flowDefinition: (connectionId: string, flowId: string) =>
    invoke<string>("flow_definition", { connectionId, flowId }),
  /** Every child flow call in the environment (reads all definitions). */
  flowCalls: (connectionId: string) => invoke<FlowCall[]>("flow_calls", { connectionId }),
  /** A page of cloud flow runs, newest first; `next` = the previous page's link. */
  flowRuns: (connectionId: string, filter: RunFilter, next: string | null) =>
    invoke<RunPage>("flow_runs", { connectionId, filter, next }),
  /** Runs and failures per flow and per hour since `since` (reads the whole window). */
  flowRunSummary: (connectionId: string, since: string) => invoke<RunSummary>("flow_run_summary", { connectionId, since }),
  /** How far this account can read `flowrun` (prvReadflowrun depth). */
  flowRunAccess: (connectionId: string) => invoke<RunReadDepth>("flow_run_access", { connectionId }),

  /** Every flow task folder the user created or opened, last opened first. */
  flowTasks: () => invoke<TaskSummary[]>("flow_tasks"),
  flowTaskDefaults: () => invoke<{ defaultRoot: string; gitAvailable: boolean }>("flow_task_defaults"),
  /** Checks where a new task folder would go. */
  flowTaskLocation: (parent: string, folder: string) => invoke<TaskLocation>("flow_task_location", { parent, folder }),
  createFlowTask: (task: NewFlowTask) => invoke<TaskView>("create_flow_task", { task }),
  /** Adds an existing task folder (with a task.json) to the list. */
  openFlowTask: (path: string) => invoke<TaskView>("open_flow_task", { path }),
  /** Takes a task off the list; the folder stays. */
  forgetFlowTask: (path: string) => invoke<void>("forget_flow_task", { path }),
  /** The task and its flows' files now (called again to notice edits). */
  flowTask: (path: string) => invoke<TaskView>("flow_task", { path }),
  updateFlowTask: (path: string, name: string, ticket: string, description: string, status: "open" | "done") =>
    invoke<TaskView>("update_flow_task", { path, name, ticket, description, status }),
  /** Reads the flows from the environment and checks them out into the task. */
  addTaskFlows: (connectionId: string, path: string, flows: { id: string; name: string }[]) =>
    invoke<TaskView>("add_task_flows", { connectionId, path, flows }),
  /** Takes a flow out of the task (its files move to .hexa/removed). */
  removeTaskFlow: (path: string, flowId: string) => invoke<TaskView>("remove_task_flow", { path, flowId }),
  setTaskFlowReviewed: (path: string, flowId: string, hash: string | null) =>
    invoke<TaskView>("set_task_flow_reviewed", { path, flowId, hash }),
  /** Earlier versions of a task flow's file (git commits or snapshots), newest first. */
  taskFlowVersions: (path: string, flowId: string) => invoke<TaskVersion[]>("task_flow_versions", { path, flowId }),
  /** `version`: "baseline" | "working" | "git:<sha>" | "snap:<file>". */
  taskFlowText: (path: string, flowId: string, version: string) => invoke<string>("task_flow_text", { path, flowId, version }),
  /** The task's flows as they are in the environment now. */
  taskLive: (connectionId: string, path: string) => invoke<LiveTaskFlow[]>("task_live", { connectionId, path }),
  /** Reads a task flow from the cloud again as its baseline; "take" also replaces the edited file (edits kept in history). */
  updateTaskBaseline: (connectionId: string, path: string, flowId: string, mode: "keep" | "take") =>
    invoke<TaskView>("update_task_baseline", { connectionId, path, flowId, mode }),
  revealFlowTask: (path: string) => invoke<void>("reveal_flow_task", { path }),
  /** Folder picker; null when cancelled. */
  pickFolder: (title: string, start: string | null) => invoke<string | null>("pick_folder", { title, start }),

  /** N:1, 1:N and N:N relationships of a table (for `<link-entity>`). */
  listRelationships: (connectionId: string, table: string) =>
    invoke<Relationship[]>("list_relationships", { connectionId, table }),
  /** System and personal views of a table (read only). */
  listViews: (connectionId: string, table: string) => invoke<ViewList>("list_views", { connectionId, table }),
  /** Open dialog for a .xml file; null when cancelled. */
  openXmlFile: () => invoke<XmlFile | null>("open_xml_file"),
  /** Writes to `path`, or asks where ("Save as") when it's null; null when cancelled. */
  saveXmlFile: (contents: string, path: string | null, suggestedName: string | null) =>
    invoke<XmlFile | null>("save_xml_file", { contents, path, suggestedName }),
  /** A table's key and name columns. */
  tableKeys: (connectionId: string, table: string) => invoke<TableKeys>("table_keys", { connectionId, table }),
  /** Save dialog for exported rows (`extension` "csv" | "json"); null when cancelled. */
  exportFile: (contents: string, suggestedName: string, extension: "csv" | "json") =>
    invoke<XmlFile | null>("export_file", { contents, suggestedName, extension }),
  /** One page of a FetchXML query; `entity` is its root `<entity name>`. */
  runFetchXml: (connectionId: string, entity: string, fetchXml: string) =>
    invoke<FetchPage>("run_fetchxml", { connectionId, entity, fetchXml }),

  /** A page of plug-in trace logs, newest first; `next` = the previous page's link. */
  traceLogs: (connectionId: string, filter: TraceFilter, next: string | null) =>
    invoke<TracePage>("trace_logs", { connectionId, filter, next }),
  /** One trace log with its full trace text and exception. */
  traceLog: (connectionId: string, id: string) => invoke<TraceDetail>("trace_log", { connectionId, id }),

  /** A page of system jobs, newest first; `next` = the previous page's link. */
  systemJobs: (connectionId: string, filter: JobFilter, next: string | null) =>
    invoke<JobPage>("system_jobs", { connectionId, filter, next }),
  /** One system job with its full messages. */
  systemJob: (connectionId: string, id: string) => invoke<JobDetail>("system_job", { connectionId, id }),
  /** Opens a record of the environment in the browser. */
  openRecord: (connectionId: string, table: string, id: string) =>
    invoke<void>("open_record", { connectionId, table, id }),

  /** Plug-in assemblies, types, service endpoints and a slim index of every step. */
  pluginOverview: (connectionId: string, hideMicrosoft: boolean) =>
    invoke<PluginOverview>("plugin_overview", { connectionId, hideMicrosoft }),
  /** Steps of one handler, one table, or matching a search. */
  pluginSteps: (connectionId: string, query: StepQuery) => invoke<PluginStep[]>("plugin_steps", { connectionId, query }),
  /** One step in full, with its images. */
  pluginStep: (connectionId: string, id: string) => invoke<PluginStepDetail>("plugin_step", { connectionId, id }),
  /** What depends on a table or column; `forDelete`: only what blocks deleting it. */
  componentDependencies: (connectionId: string, table: string, column: string | null, forDelete: boolean) =>
    invoke<DependencyReport>("component_dependencies", { connectionId, table, column, forDelete }),
  /** Cloud flows whose definition names the table (and column). Reads every definition. */
  flowsMentioning: (connectionId: string, table: string, column: string | null) =>
    invoke<FlowMention[]>("flows_mentioning", { connectionId, table, column }),
  /** Every visible web resource (no content), with its solutions. */
  webResources: (connectionId: string) => invoke<WebResourceList>("web_resources", { connectionId }),
  /** One web resource with its published and unpublished content. */
  webResource: (connectionId: string, id: string) => invoke<WebResourceDetail>("web_resource", { connectionId, id }),
  /** What uses a web resource (forms, ribbons, other web resources…); `forDelete`: only what blocks deleting it. */
  webResourceDependents: (connectionId: string, id: string, forDelete = false) =>
    invoke<DependencyItem[]>("web_resource_dependents", { connectionId, id, forDelete }),
  /** Saves content (base64), not published. `baseHash`: refuse ("CONFLICT: …") when someone saved meanwhile. */
  saveWebResource: (connectionId: string, id: string, content: string, baseHash: string | null) =>
    invoke<{ hash: string }>("save_web_resource", { connectionId, id, content, baseHash }),
  /** Publishes web resources in one request. */
  publishWebResources: (connectionId: string, ids: string[]) => invoke<void>("publish_web_resources", { connectionId, ids }),
  /** Creates a web resource (not published); returns its id. */
  createWebResource: (connectionId: string, resource: NewWebResource) => invoke<string>("create_web_resource", { connectionId, resource }),
  deleteWebResource: (connectionId: string, id: string) => invoke<void>("delete_web_resource", { connectionId, id }),
  /** Asks for a file and reads it as base64; null when cancelled. */
  openWebResourceFile: () => invoke<PickedFile | null>("open_web_resource_file"),
  /** Opens the published web resource in the browser. */
  openWebResource: (connectionId: string, name: string) => invoke<void>("open_web_resource", { connectionId, name }),
  /** Saves content (base64) to a file the user picks; null when cancelled. */
  saveWebResourceFile: (content: string, fileName: string) =>
    invoke<{ path: string; name: string } | null>("save_web_resource_file", { content, fileName }),
  securityUsers: (connectionId: string) => invoke<SecurityUser[]>("security_users", { connectionId }),
  securityRoles: (connectionId: string) => invoke<SecurityRole[]>("security_roles", { connectionId }),
  userRoles: (connectionId: string, userId: string) => invoke<UserRoles>("user_roles", { connectionId, userId }),
  rolePrivileges: (connectionId: string, roleId: string) => invoke<RolePrivilege[]>("role_privileges", { connectionId, roleId }),
  principalAccess: (connectionId: string, userId: string, table: string, recordId: string) =>
    invoke<AccessCheck>("principal_access", { connectionId, userId, table, recordId }),

  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (clientId: string, tenant: string, workerThreads: number) =>
    invoke<Settings>("set_settings", { clientId, tenant, workerThreads }),
};
