import { type ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { getPassword } from '../lib/auth';

export function RequireAuth({ children }: { children: ReactNode }) {
  if (!getPassword()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
