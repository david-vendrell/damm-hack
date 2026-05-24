import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function pts(n: number, digits?: number): string {
  const sign = n >= 0 ? '+' : '';
  // Auto-pick precision so small but real deltas (e.g. +0.04 pts from a
  // single OF reassignment) don't display as "+0.0 pts". When |n| < 0.1 we
  // bump to 2 decimals; otherwise 1. Caller can still force a value.
  const d = digits ?? (Math.abs(n) < 0.1 ? 2 : 1);
  return `${sign}${n.toFixed(d)} pts`;
}

export function hl(n: number): string {
  return Math.round(n).toLocaleString('es-ES') + ' Hl';
}
