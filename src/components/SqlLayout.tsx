import { Outlet, useOutletContext } from "react-router";
import type { LayoutContext } from "../App";

/**
 * Layout of the SQL tool. The Query view isn't here: RootLayout keeps it
 * mounted across every tool so the Monaco editor never loses its state.
 */
export function SqlLayout() {
  const ctx = useOutletContext<LayoutContext>();
  return <Outlet context={ctx} />;
}
