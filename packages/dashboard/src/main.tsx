import { I18nProvider } from '@lingui/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Layout } from './components/Layout';
import { RequireAuth } from './components/RequireAuth';
import { SetupGate } from './components/SetupGate';
import './index.css';
import { DenominationProvider } from './lib/denomination';
import { getInitialLocale, i18n, loadAndActivate } from './lib/i18n';
import { LocaleContext, useLocaleState } from './lib/locale';
import { Config } from './pages/Config';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
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
    <I18nProvider i18n={i18n}>
      <LocaleContext.Provider value={locale}>
        <QueryClientProvider client={queryClient}>
          <DenominationProvider>
            <BrowserRouter>
              <SetupGate>
                <Routes>
                  <Route path="/setup" element={<Setup />} />
                  <Route path="/login" element={<Login />} />
                  <Route
                    element={
                      <RequireAuth>
                        <Layout />
                      </RequireAuth>
                    }
                  >
                    <Route index element={<Status />} />
                    <Route path="/config" element={<Config />} />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Route>
                </Routes>
              </SetupGate>
            </BrowserRouter>
          </DenominationProvider>
        </QueryClientProvider>
      </LocaleContext.Provider>
    </I18nProvider>
  );
}

// Load + activate the operator's locale before first render so the UI
// never paints English-then-translation flash for non-EN users. Catalogs
// are tiny and same-origin so this is sub-100ms in practice. If the
// load somehow fails, fall back to English (already the source-string
// render path) and let the app start.
loadAndActivate(getInitialLocale())
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('i18n catalog load failed; falling back to source strings', err);
  })
  .finally(() => {
    createRoot(root).render(
      <StrictMode>
        <AppShell />
      </StrictMode>,
    );
  });
