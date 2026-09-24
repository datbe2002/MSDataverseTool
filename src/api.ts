import { invoke as tauriInvoke, type InvokeArgs } from "@tauri-apps/api/core";
import { withReauth } from "./lib/reauth";
import type {
  Cell,
  ColumnMeta,
  Connection,
  DmlPreview,
  DmlResult,
  EngineMode,
  Environment,
  FetchPage,
  FlowCall,
  FlowList,
  Project,
  QueryResult,
  Relationship,
  Settings,
  TableChoices,
  TableKeys,
  TableMeta,
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

  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (clientId: string, tenant: string, workerThreads: number) =>
    invoke<Settings>("set_settings", { clientId, tenant, workerThreads }),
};
