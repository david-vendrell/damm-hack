import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function pct(n: number, digits = 0): string {
  return `${(n * 100).toFixed(digits)}%`;
}

export function pts(n: number, digits = 1): string {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)} pts`;
}

export function hl(n: number): string {
  return Math.round(n).toLocaleString('es-ES') + ' Hl';
}
