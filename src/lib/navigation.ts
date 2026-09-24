// App routes, plus a navigate() that non-React code (the store) can call
// without importing the router — which would create an import cycle.

export const ROUTES = {
  overview: "/sql/overview",
  query: "/sql/query",
  schema: "/sql/schema",
  history: "/sql/history",
  flows: "/flows",
  fetchxml: "/fetchxml",
} as const;

/** A flow in the Flows tool; the id is the `workflow` row's id. */
export const flowRoute = (flowId: string) => `${ROUTES.flows}/${flowId}`;

let navigator: (to: string) => void = () => {};

/** Registered once by the router at startup. */
export function setNavigator(fn: (to: string) => void) {
  navigator = fn;
}

export function navigate(to: string) {
  navigator(to);
}
