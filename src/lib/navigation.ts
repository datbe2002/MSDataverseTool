// App routes, plus a navigate() that non-React code (the store) can call
// without importing the router — which would create an import cycle.

export const ROUTES = {
  overview: "/sql/overview",
  query: "/sql/query",
  schema: "/sql/schema",
  history: "/sql/history",
  flows: "/flows",
  flowtasks: "/flowtasks",
  fetchxml: "/fetchxml",
  traces: "/traces",
  jobs: "/jobs",
  flowruns: "/flowruns",
  plugins: "/plugins",
  dependencies: "/dependencies",
  security: "/security",
  webresources: "/webresources",
} as const;

/** A flow in the Flows tool; the id is the `workflow` row's id. */
export const flowRoute = (flowId: string) => `${ROUTES.flows}/${flowId}`;

/** A flow task (by folder path), optionally at one of its flows. */
export const flowTaskRoute = (path: string, flowId?: string | null) =>
  `${ROUTES.flowtasks}?task=${encodeURIComponent(path)}${flowId ? `&flow=${encodeURIComponent(flowId)}` : ""}`;

/** A plug-in trace log; the id is the `plugintracelog` row's id. */
export const traceRoute = (traceId: string) => `${ROUTES.traces}/${traceId}`;

/** A system job; the id is the `asyncoperation` row's id. */
/** A node of the Plug-in steps tree, e.g. `step:<id>`. */
export const pluginRoute = (node: string) => `${ROUTES.plugins}?node=${encodeURIComponent(node)}`;

/** A web resource in the Web resources tool; the id is the `webresource` row's id. */
export const webResourceRoute = (id: string) => `${ROUTES.webresources}?id=${encodeURIComponent(id)}`;

export const jobRoute = (jobId: string) => `${ROUTES.jobs}/${jobId}`;

let navigator: (to: string) => void = () => {};

/** Registered once by the router at startup. */
export function setNavigator(fn: (to: string) => void) {
  navigator = fn;
}

export function navigate(to: string) {
  navigator(to);
}
