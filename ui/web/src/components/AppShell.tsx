import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Logo } from "./Logo";
import { useAuth } from "@/lib/auth";
import {
  Avatar, AvatarFallback, Button, Drawer, DrawerContent, DrawerTrigger, ThemeToggle,
} from "@/components/ui";
import { FileText, Info, Layers, LogOut, Menu, Network, Users as UsersIcon } from "lucide-react";

export function AppShell() {
  const { me, logout } = useAuth();
  const loc = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Auto-close the mobile drawer on route change.
  useEffect(() => { setDrawerOpen(false); }, [loc.pathname]);

  return (
    <div className="h-screen flex bg-bg text-fg">
      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-64 shrink-0 flex-col border-r border-border bg-bg-elevated">
        <SidebarBody me={me} logout={logout} />
      </aside>

      {/* Mobile top bar with hamburger trigger */}
      <Drawer open={drawerOpen} onOpenChange={setDrawerOpen}>
        <div className="md:hidden fixed top-0 inset-x-0 h-14 z-30 bg-bg-elevated/90 backdrop-blur border-b border-border px-2 flex items-center gap-2">
          <DrawerTrigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open menu">
              <Menu className="size-5" />
            </Button>
          </DrawerTrigger>
          <Logo size={26} />
          <div className="font-semibold flex-1 truncate">discovery</div>
          <ThemeToggle />
        </div>
        <DrawerContent side="left" className="w-72 p-0">
          <SidebarBody me={me} logout={logout} />
        </DrawerContent>
      </Drawer>

      <main className="flex-1 min-w-0 flex flex-col md:pt-0 pt-14">
        <div className="flex-1 min-h-0 overflow-y-auto" key={loc.pathname}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function SidebarBody({ me, logout }: { me: ReturnType<typeof useAuth>["me"]; logout: () => void }) {
  const initial = (me?.displayName || me?.username || "?").trim().charAt(0).toUpperCase();
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 h-16 px-5 border-b border-border">
        <Logo size={32} />
        <div className="font-semibold tracking-tight truncate flex-1">discovery</div>
      </div>
      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        <NavItem to="/" end icon={<Layers className="size-4" />}>Services</NavItem>
        <NavItem to="/cluster" icon={<Network className="size-4" />}>Cluster</NavItem>
        {me?.isAdmin && (
          <>
            <div className="pt-3 pb-1 px-3 text-[11px] uppercase tracking-wider text-fg-subtle">Admin</div>
            <NavItem to="/users" icon={<UsersIcon className="size-4" />}>Users</NavItem>
            <NavItem to="/audit" icon={<FileText className="size-4" />}>Audit log</NavItem>
          </>
        )}
        <div className="pt-3 pb-1 px-3 text-[11px] uppercase tracking-wider text-fg-subtle">Help</div>
        <NavItem to="/about" icon={<Info className="size-4" />}>About</NavItem>
      </nav>
      <div className="border-t border-border p-3 space-y-3">
        <div className="flex items-center gap-3">
          <Avatar className="bg-accent text-accent-fg shrink-0">
            <AvatarFallback className="bg-accent text-accent-fg font-semibold">{initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium truncate">{me?.displayName || me?.username}</div>
            <div className="text-xs text-fg-muted truncate">
              {me?.isAdmin ? "Administrator" : (me?.username ?? "anonymous")}
            </div>
          </div>
          <ThemeToggle />
        </div>
        <Button variant="secondary" className="w-full" onClick={logout} leftIcon={<LogOut className="size-4" />}>
          Sign out
        </Button>
      </div>
    </div>
  );
}

function NavItem({ to, end, icon, children }: { to: string; end?: boolean; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        [
          "flex items-center gap-3 rounded-[var(--radius-md)] px-3 py-2 text-sm font-medium transition-colors",
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

