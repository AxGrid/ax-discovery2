import { BrowserRouter, Route, Routes, Navigate, useLocation } from "react-router-dom";
import { AppShell } from "./components/AppShell";
import Dashboard from "./pages/Dashboard";
import Services from "./pages/Services";
import Config from "./pages/Config";
import ServiceDetail from "./pages/ServiceDetail";
import Cluster from "./pages/Cluster";
import About from "./pages/About";
import Login from "./pages/Login";
import Audit from "./pages/Audit";
import Tokens from "./pages/Tokens";
import { useAuth } from "./lib/auth";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return null;
  if (!me?.authenticated) {
    return <Navigate to="/login" state={{ from: loc.pathname + loc.search }} replace />;
  }
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return null;
  if (!me?.authenticated) return <Navigate to="/login" replace />;
  if (!me.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route index element={<Dashboard />} />
          <Route path="/services" element={<Services />} />
          <Route path="/services/:name" element={<ServiceDetail />} />
          <Route path="/config" element={<Config />} />
          <Route path="/cluster" element={<Cluster />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/audit" element={<RequireAdmin><Audit /></RequireAdmin>} />
          <Route path="/about" element={<About />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
