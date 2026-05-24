'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';

const SCENE_SRC = '/interactive-3d/linewise_tres_lineas_oee_fabrica_3d_sin_paredes.html';

export default function LandingPage() {
  const [revealed, setRevealed] = useState(false);
  const [hintVisible, setHintVisible] = useState(false);

  useEffect(() => {
    const t1 = setTimeout(() => setRevealed(true), 80);
    const t2 = setTimeout(() => setHintVisible(true), 1400);
    const t3 = setTimeout(() => setHintVisible(false), 7200);
    document.documentElement.classList.add('lw-landing-lock');
    document.body.classList.add('lw-landing-lock');
    return () => {
      clearTimeout(t1); clearTimeout(t2); clearTimeout(t3);
      document.documentElement.classList.remove('lw-landing-lock');
      document.body.classList.remove('lw-landing-lock');
    };
  }, []);

  return (
    <main className="fixed inset-0 overflow-hidden bg-black">
      <style>{`
        html.lw-landing-lock, body.lw-landing-lock { overflow: hidden !important; background: #05080f !important; }
        body.lw-landing-lock { background-image: none !important; }
      `}</style>

      <iframe
        src={SCENE_SRC}
        title="LineWise · Línea de latas en 3D"
        allow="autoplay; fullscreen"
        className="absolute inset-0 w-full h-full"
        style={{ border: 0, background: '#05080f' }}
      />

      {/* Top-left brand overlay */}
      <div
        className="pointer-events-none absolute top-5 left-6 z-10 transition-opacity duration-700"
        style={{ opacity: revealed ? 1 : 0 }}
      >
        <div className="flex items-center gap-3">
          <span
            className="inline-block h-7 w-1 rounded-full"
            style={{ background: 'var(--damm)' }}
          />
          <div className="leading-tight">
            <div className="text-[15px] font-semibold tracking-wide" style={{ color: '#f1f5f9', textShadow: '0 1px 8px rgba(0,0,0,0.45)' }}>
              LineWise <span className="opacity-50">· Damm</span>
            </div>
            <div className="text-[11px]" style={{ color: '#a8b3c4', textShadow: '0 1px 6px rgba(0,0,0,0.4)' }}>
              El Prat · Líneas 14 · 17 · 19
            </div>
          </div>
        </div>
      </div>

      {/* Bottom-right CTA */}
      <div
        className="absolute bottom-6 right-6 z-10 flex flex-col items-end gap-2 transition-opacity duration-700"
        style={{ opacity: revealed ? 1 : 0 }}
      >
        <div
          className="pointer-events-none text-[11px] tracking-wide transition-opacity duration-700"
          style={{
            opacity: hintVisible ? 1 : 0,
            color: '#cbd5e1',
            textShadow: '0 1px 6px rgba(0,0,0,0.55)',
          }}
        >
          Pulsa <span className="font-semibold text-white">▷ Demo</span> en la barra inferior para iniciar la presentación
        </div>
        <Link
          href="/observabilidad"
          className="group inline-flex items-center gap-2 rounded-xl px-5 py-2.5 text-[13px] font-semibold transition-all"
          style={{
            background: 'linear-gradient(135deg, rgba(15,23,42,0.92), rgba(30,41,59,0.85))',
            border: '1px solid rgba(148,163,184,0.35)',
            color: '#f8fafc',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            boxShadow: '0 0 22px rgba(164,22,26,0.32), inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
        >
          <span>Entrar al panel</span>
          <span className="transition-transform group-hover:translate-x-0.5">→</span>
        </Link>
      </div>
    </main>
  );
}
