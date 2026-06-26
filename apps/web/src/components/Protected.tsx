import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useSession } from "../lib/auth";

/** Gate authenticated routes; bounce to /login when there's no session. */
export function Protected({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();
  if (isPending) {
    return <div className="screen-center muted">Loading…</div>;
  }
  if (!data) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
