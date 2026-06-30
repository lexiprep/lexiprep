import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useSession, signOut } from "../lib/auth";
import { useBodyScrollLock } from "../lib/useBodyScrollLock";

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

/** Primary navigation — add new top-level pages here and they appear in both the desktop
 * bar and the mobile menu. */
const LINKS: { to: string; label: string; end?: boolean }[] = [
  { to: "/", label: "Books", end: true },
  { to: "/learning", label: "Vocabulary" },
  { to: "/review", label: "Review" },
  { to: "/stats", label: "Stats" },
];

export function Layout() {
  const { data } = useSession();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  const signOutAndGo = async () => {
    setMenuOpen(false);
    await signOut();
    navigate("/login");
  };

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          lexiprep
        </Link>
        <nav className="nav">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={navClass}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="grow" />
        <button
          className="menu-btn"
          aria-label="Menu"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="burger" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      </header>

      {menuOpen && (
        <NavMenu
          email={data?.user?.email ?? null}
          onClose={() => setMenuOpen(false)}
          onSignOut={signOutAndGo}
        />
      )}

      <main className="container">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * The full-screen menu behind the burger: it takes over the whole view (not a dropdown),
 * listing the nav links and account actions (email + sign out). Closes on the × or Escape;
 * locks background scroll via the shared {@link useBodyScrollLock}.
 */
function NavMenu({
  email,
  onClose,
  onSignOut,
}: {
  email: string | null;
  onClose: () => void;
  onSignOut: () => void;
}) {
  useBodyScrollLock();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="menu-overlay" role="dialog" aria-modal="true">
      <div className="menu-overlay-head">
        <Link to="/" className="brand" onClick={onClose}>
          lexiprep
        </Link>
        <button className="menu-close" aria-label="Close menu" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="menu-overlay-body">
        <nav className="menu-overlay-nav">
          {LINKS.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.end} className={navClass} onClick={onClose}>
              {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="menu-overlay-foot">
          {email && <span className="muted small">{email}</span>}
          <button className="btn ghost menu-signout" onClick={onSignOut}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
