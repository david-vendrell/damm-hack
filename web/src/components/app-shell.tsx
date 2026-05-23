'use client';

import { Suspense, type ReactNode } from 'react';
import { ScopeProvider } from './scope-provider';
import { Sidebar } from './sidebar';
import { TopBar } from './top-bar';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={null}>
      <ScopeProvider>
        <div className="flex min-h-screen bg-cream">
          <Sidebar />
          <div className="flex min-h-screen flex-1 flex-col">
            <TopBar />
            <main className="flex-1 px-8 py-8">{children}</main>
          </div>
        </div>
      </ScopeProvider>
    </Suspense>
  );
}
