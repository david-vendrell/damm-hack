import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';
import { QueryProvider } from '@/components/query-provider';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  weight: ['400', '500', '600', '700'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LineWise — Damm',
  description: 'Decisión asistida para planificación de líneas 14, 17, 19',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={inter.variable}>
      <body className="min-h-screen bg-cream text-ink antialiased">
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
