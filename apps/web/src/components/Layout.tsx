import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useSession, signOut } from "../lib/auth";

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? "active" : "");

export function Layout() {
  const { data } = useSession();
  const navigate = useNavigate();

  return (
    <div className="app">
      <header className="topbar">
        <Link to="/" className="brand">
          lexiprep
        </Link>
        <nav className="nav">
          <NavLink to="/" end className={navClass}>
            Books
          </NavLink>
          <NavLink to="/learning" className={navClass}>
            Vocabulary
          </NavLink>
          <NavLink to="/stats" className={navClass}>
            Stats
          </NavLink>
        </nav>
        <div className="grow" />
        {data?.user?.email && <span className="muted small">{data.user.email}</span>}
        <button
          className="btn ghost"
          onClick={async () => {
            await signOut();
            navigate("/login");
          }}
        >
          Sign out
        </button>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </div>
  );
}
