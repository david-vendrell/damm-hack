import type { Metadata } from 'next';
import './globals.css';
import { QueryProvider } from '@/components/query-provider';
import { Header } from '@/components/header';

export const metadata: Metadata = {
  title: 'LineWise — Damm',
  description: 'Decisión asistida para planificación de líneas 14, 17, 19',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-screen bg-cream text-ink">
        <QueryProvider>
          <Header />
          <main className="mx-auto max-w-[1280px] px-6 py-8">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}
