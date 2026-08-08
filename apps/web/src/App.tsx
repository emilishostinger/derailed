import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { FullPageLoader } from './components/ui.tsx';
import { Agents } from './pages/Agents.tsx';
import { Analytics } from './pages/Analytics.tsx';
import { Ask } from './pages/Ask.tsx';
import { Backups } from './pages/Backups.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Domains } from './pages/Domains.tsx';
import { Help } from './pages/Help.tsx';
import { Layout } from './pages/Layout.tsx';
import { Login } from './pages/Login.tsx';
import { Logs } from './pages/Logs.tsx';
import { Onboarding } from './pages/Onboarding.tsx';
import { ProjectPage } from './pages/Project.tsx';
import { Server } from './pages/Server.tsx';
import { Settings } from './pages/Settings.tsx';
import { Trash } from './pages/Trash.tsx';
import { Updates } from './pages/Updates.tsx';
import { Uptime } from './pages/Uptime.tsx';
import { useSession } from './stores/session.ts';

export function App() {
  const phase = useSession((s) => s.phase);
  const bootstrap = useSession((s) => s.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (phase === 'loading') return <FullPageLoader />;
  if (phase === 'setup') return <Onboarding />;
  if (phase === 'anonymous') return <Login />;

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/p/:slug" element={<ProjectPage />} />
          <Route path="/domains" element={<Domains />} />
          <Route path="/server" element={<Server />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/updates" element={<Updates />} />
          <Route path="/backups" element={<Backups />} />
          <Route path="/trash" element={<Trash />} />
          <Route path="/uptime" element={<Uptime />} />
          <Route path="/agents" element={<Agents />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/help" element={<Help />} />
          <Route path="/help/:slug" element={<Help />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
