import { useState, type FormEvent } from "react";
import { Navigate } from "react-router-dom";
import { useSession, signIn, signUp } from "../lib/auth";

export function LoginPage() {
  const { data: session, isPending } = useSession();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isPending && session) return <Navigate to="/" replace />;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res =
        mode === "signup"
          ? await signUp.email({ name: name || email, email, password })
          : await signIn.email({ email, password });
      if (res.error) setError(res.error.message ?? "Authentication failed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authentication failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen-center">
      <form className="card auth-card" onSubmit={onSubmit}>
        <h1 className="brand">lexiprep</h1>
        <p className="muted small">Pre-reading vocabulary preparation</p>

        {mode === "signup" && (
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </label>
        )}
        <label className="field">
          <span>Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>

        <p className="muted small center">
          {mode === "signup" ? "Already have an account?" : "No account yet?"}{" "}
          <button
            type="button"
            className="linkbtn"
            onClick={() => {
              setMode(mode === "signup" ? "signin" : "signup");
              setError(null);
            }}
          >
            {mode === "signup" ? "Sign in" : "Create one"}
          </button>
        </p>
      </form>
    </div>
  );
}
