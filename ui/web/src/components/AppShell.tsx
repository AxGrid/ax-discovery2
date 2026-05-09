import { NavLink, Outlet } from "react-router-dom";
import { ThemeToggle } from "./ThemeToggle";
import { Logo } from "./Logo";
import { useAuth } from "@/lib/auth";

export function AppShell() {
  const { me, logout } = useAuth();

  return (
    <div className="h-screen flex bg-zinc-50 dark:bg-zinc-950">
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="flex items-center gap-3 h-16 px-5 border-b border-zinc-200 dark:border-zinc-800">
          <Logo size={32} />
          <div className="font-semibold tracking-tight truncate flex-1">discovery</div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          <NavLink to="/" end className={({isActive}) => `nav-link ${isActive ? "nav-link-active" : ""}`}>
            <IconList /> <span>Services</span>
          </NavLink>
          <NavLink to="/cluster" className={({isActive}) => `nav-link ${isActive ? "nav-link-active" : ""}`}>
            <IconCluster /> <span>Cluster</span>
          </NavLink>
          {me?.isAdmin && (
            <>
              <div className="pt-3 pb-1 px-3 text-[11px] uppercase tracking-wider text-zinc-400">Admin</div>
              <NavLink to="/users" className={({isActive}) => `nav-link ${isActive ? "nav-link-active" : ""}`}>
                <IconUsers /> <span>Users</span>
              </NavLink>
              <NavLink to="/audit" className={({isActive}) => `nav-link ${isActive ? "nav-link-active" : ""}`}>
                <IconAudit /> <span>Audit log</span>
              </NavLink>
            </>
          )}
          <div className="pt-3 pb-1 px-3 text-[11px] uppercase tracking-wider text-zinc-400">Help</div>
          <NavLink to="/about" className={({isActive}) => `nav-link ${isActive ? "nav-link-active" : ""}`}>
            <IconInfo /> <span>About</span>
          </NavLink>
        </nav>
        <div className="border-t border-zinc-200 dark:border-zinc-800 p-3 space-y-3">
          <div className="flex items-center gap-3">
            <UserAvatar name={me?.displayName || me?.username || "?"} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium truncate">{me?.displayName || me?.username}</div>
              <div className="text-xs text-zinc-500 truncate">
                {me?.isAdmin ? "Administrator" : (me?.username ?? "anonymous")}
              </div>
            </div>
            <ThemeToggle />
          </div>
          <button onClick={logout} className="btn-secondary w-full">Sign out</button>
        </div>
      </aside>

      <div className="md:hidden fixed top-0 inset-x-0 h-14 z-30 bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 px-3 flex items-center gap-2">
        <Logo size={26} />
        <div className="font-semibold flex-1">discovery</div>
        <ThemeToggle />
      </div>

      <main className="flex-1 min-w-0 flex flex-col md:pt-0 pt-14">
        <div className="flex-1 min-h-0 overflow-y-auto">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function UserAvatar({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase();
  return (
    <div className="h-9 w-9 rounded-full bg-gradient-to-br from-brand-400 to-brand-600 text-white font-semibold flex items-center justify-center shrink-0">
      {initial}
    </div>
  );
}

function IconList() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3" cy="6" r="1"/><circle cx="3" cy="12" r="1"/><circle cx="3" cy="18" r="1"/></svg>;
}
function IconCluster() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M12 8v4M9 16l2-3M15 16l-2-3"/></svg>;
}
function IconUsers() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
}
function IconAudit() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>;
}
function IconInfo() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="8"/></svg>;
}
