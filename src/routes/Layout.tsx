import { NavLink, Outlet } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { backupIsOverdue, getSettings } from '../repo';
import { useTheme } from '../ui/useTheme';
import { ThemeToggle } from '../ui/ThemeToggle';
import { SyncBadge } from '../ui/SyncBadge';

export function Layout() {
  const settings = useLiveQuery(() => getSettings(), []);
  useTheme(settings?.theme);

  const overdue = settings ? backupIsOverdue(settings) : false;

  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <span className="mark">{'{{'}</span>
          <span>Cloze</span>
        </NavLink>
        <nav className="nav">
          <NavLink to="/" end>
            Decks
          </NavLink>
          <NavLink to="/browse">Browse</NavLink>
          <NavLink to="/stats">Stats</NavLink>
          <NavLink to="/backup">
            Backup
            {overdue ? (
              <span className="nav__dot" title="No recent backup" aria-label="No recent backup" />
            ) : null}
          </NavLink>
          <NavLink to="/settings">Settings</NavLink>
        </nav>
        <SyncBadge />
        <ThemeToggle theme={settings?.theme} />
      </header>
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
