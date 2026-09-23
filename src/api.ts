import { invoke } from "@tauri-apps/api/core";
import type {
  Cell,
  ColumnMeta,
  Connection,
  DmlPreview,
  DmlResult,
  EngineMode,
  Environment,
  FlowCall,
  FlowList,
  Project,
  QueryResult,
  Settings,
  TableMeta,
} from "./types";

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

  listFlows: (connectionId: string) => invoke<FlowList>("list_flows", { connectionId }),
  /** The flow's definition JSON (`clientdata`), pretty-printed. */
  flowDefinition: (connectionId: string, flowId: string) =>
    invoke<string>("flow_definition", { connectionId, flowId }),
  /** Every child flow call in the environment (reads all definitions). */
  flowCalls: (connectionId: string) => invoke<FlowCall[]>("flow_calls", { connectionId }),

  getSettings: () => invoke<Settings>("get_settings"),
  setSettings: (clientId: string, tenant: string, workerThreads: number) =>
    invoke<Settings>("set_settings", { clientId, tenant, workerThreads }),
};
