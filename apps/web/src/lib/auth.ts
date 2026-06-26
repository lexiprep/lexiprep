import { createAuthClient } from "better-auth/react";

// /api/auth/* is proxied to the server in dev, so the current origin is the base.
export const authClient = createAuthClient({
  baseURL: window.location.origin,
});

export const { useSession, signIn, signUp, signOut } = authClient;
