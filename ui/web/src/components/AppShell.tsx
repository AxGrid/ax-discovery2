import { NavLink, Outlet } from "react-router-dom";
import { Logo } from "./Logo";
import { useAuth } from "@/lib/auth";
import {
  Avatar, AvatarFallback, Button, ThemeToggle,
  Tooltip, TooltipContent, TooltipTrigger,
} from "@/components/ui";
import { FileText, Info, KeyRound, LayoutDashboard, Layers, LogOut, Network, SlidersHorizontal } from "lucide-react";

// AppShell renders a top bar instead of a sidebar. The reasoning:
//
// - In iframe mode the corp-ui host already owns the left sidebar; a
//   second one inside our iframe would mean two nested nav columns and
//   wasted horizontal space. Top nav reads as "tabs of this module"
//   instead of "second app".
// - In standalone mode the top bar is no worse — discovery only has
//   three or four top-level routes, comfortably fits horizontally on
//   any reasonable laptop, and the layout matches the iframe one so
//   muscle memory carries between contexts.

export function AppShell() {
  const { me, logout, mode } = useAuth();
  return (
    <div className="h-screen flex flex-col bg-bg text-fg">
      <TopBar me={me} logout={logout} mode={mode} />
      <main className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </main>
    </div>
  );
}

function TopBar({ me, logout, mode }: {
  me: ReturnType<typeof useAuth>["me"];
  logout: () => void;
  mode: ReturnType<typeof useAuth>["mode"];
}) {
  const initial = (me?.displayName || me?.email || me?.username || "?").trim().charAt(0).toUpperCase();
  const subtitle = me?.isAdmin ? "Administrator" : (me?.email ?? me?.username ?? "anonymous");
  // In iframe mode the host owns the sign-out lifecycle — clicking sign
  // out here would only clear our cached token while the corp-ui session
  // stays alive, which is a confusing partial-logout state. Hide it.
  const showLogout = mode === "standalone";

  return (
    <header className="shrink-0 h-16 px-4 sm:px-6 border-b border-border bg-bg-elevated">
      <div className="h-full flex items-center gap-4 sm:gap-6">
        {/* Brand */}
        <NavLink to="/" className="flex items-center gap-2.5 shrink-0">
          <Logo size={28} />
          <span className="font-semibold tracking-tight hidden sm:inline">discovery</span>
        </NavLink>

        {/* Primary navigation. flex-wrap is intentional — corp-module
            skill warns that overflow-x-auto on tabs hides items off-screen
            and is discoverability poison. Four short items wrap cleanly
            into two rows on narrow screens instead. */}
        <nav className="flex flex-wrap items-center gap-1 min-w-0 flex-1">
          <NavItem to="/" end icon={<LayoutDashboard className="size-4" />}>Dashboard</NavItem>
          <NavItem to="/services" icon={<Layers className="size-4" />}>Services</NavItem>
          <NavItem to="/config" icon={<SlidersHorizontal className="size-4" />}>Config</NavItem>
          <NavItem to="/cluster" icon={<Network className="size-4" />}>Cluster</NavItem>
          <NavItem to="/tokens" icon={<KeyRound className="size-4" />}>Tokens</NavItem>
          {me?.isAdmin && (
            <NavItem to="/audit" icon={<FileText className="size-4" />}>Audit</NavItem>
          )}
          <NavItem to="/about" icon={<Info className="size-4" />}>About</NavItem>
        </nav>

        {/* Right cluster: theme + identity */}
        <div className="flex items-center gap-2 sm:gap-3 shrink-0">
          <ThemeToggle />
          <Tooltip>
            <TooltipTrigger asChild>
              <Avatar className="bg-accent text-accent-fg size-8">
                <AvatarFallback className="bg-accent text-accent-fg font-semibold text-sm">
                  {initial}
                </AvatarFallback>
              </Avatar>
            </TooltipTrigger>
            <TooltipContent>
              <div className="text-sm font-medium">{me?.displayName || me?.email || me?.username}</div>
              <div className="text-xs text-fg-muted">{subtitle}</div>
            </TooltipContent>
          </Tooltip>
          {showLogout && (
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="size-4" />
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function NavItem({ to, end, icon, children }: { to: string; end?: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          "flex items-center gap-2 rounded-[var(--radius-md)] px-3 py-1.5 text-sm font-medium transition-colors",
          isActive
            ? "bg-[color-mix(in_oklab,var(--brand-500)_12%,transparent)] text-accent"
            : "text-fg-muted hover:text-fg hover:bg-surface-hover",
        ].join(" ")
      }
    >
      {icon}
      <span>{children}</span>
    </NavLink>
  );
}
