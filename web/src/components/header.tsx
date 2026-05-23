'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { clsx } from 'clsx';

const tabs = [
  { href: '/observabilidad', label: 'Observabilidad' },
  { href: '/post-mortem', label: 'Post mortem' },
  { href: '/validar', label: 'Validar planificación' },
  { href: '/urgencias', label: 'Urgencias' },
];

export function Header() {
  const pathname = usePathname();
  return (
    <header className="border-b border-hairline bg-surface">
      <div className="mx-auto flex max-w-[1280px] items-end justify-between px-6 pt-6 pb-0">
        <div className="flex items-baseline gap-3">
          <span className="text-2xl font-bold tracking-tight text-ink">Damm</span>
          <span className="text-sm text-muted">LineWise</span>
        </div>
        <nav className="flex gap-1">
          {tabs.map((t) => {
            const active = pathname.startsWith(t.href);
            return (
              <Link
                key={t.href}
                href={t.href}
                className={clsx(
                  'px-4 py-3 text-sm transition-colors',
                  active
                    ? 'border-b-2 border-damm font-medium text-ink'
                    : 'border-b-2 border-transparent text-muted hover:text-ink',
                )}
              >
                {t.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
