import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import './index.css';
import { DenominationProvider } from './lib/denomination';
import { LocaleContext, useLocaleState } from './lib/locale';
import { Config } from './pages/Config';
import { Decisions } from './pages/Decisions';
import { Login } from './pages/Login';
import { Simulate } from './pages/Simulate';
import { Status } from './pages/Status';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

function AppShell() {
  const locale = useLocaleState();
  return (
    <LocaleContext.Provider value={locale}>
      <QueryClientProvider client={queryClient}>
        <DenominationProvider>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route
                element={
                  <RequireAuth>
                    <Layout />
                  </RequireAuth>
                }
              >
                <Route index element={<Status />} />
                <Route path="/decisions" element={<Decisions />} />
                <Route path="/simulate" element={<Simulate />} />
                <Route path="/config" element={<Config />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </DenominationProvider>
      </QueryClientProvider>
    </LocaleContext.Provider>
  );
}

createRoot(root).render(
  <StrictMode>
    <AppShell />
  </StrictMode>,
);
