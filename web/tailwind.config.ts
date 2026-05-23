import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces — warm Mediterranean, never pure white as canvas
        bone: '#FAF7F1',
        cream: '#F5F1EA',
        linen: '#EFE9DE',
        surface: '#FFFFFF',
        sand: '#F2ECDF',

        // Ink — warm-grey, not pure black
        ink: {
          DEFAULT: '#171513',
          2: '#3A3631',
          3: '#6E665B',
          4: '#A39B8C',
        },
        muted: '#6E665B',

        // Hairlines — warm
        hairline: {
          DEFAULT: '#E8E1D3',
          strong: '#D6CDB9',
        },

        // Damm red — full scale
        damm: {
          DEFAULT: '#A4161A',
          50: '#FBEAEA',
          100: '#F5D2D3',
          200: '#EDA8AA',
          300: '#E07D80',
          400: '#C84A4E',
          500: '#A4161A',
          600: '#8A1115',
          700: '#7E1116',
          800: '#5C0B0E',
          900: '#3F0709',
          hover: '#7E1116',
          soft: '#FBEAEA',
        },

        // Gold / amber — production volume / output / OEE
        gold: {
          DEFAULT: '#C99700',
          50: '#FCF6E2',
          100: '#F7E9B6',
          200: '#EFD477',
          300: '#E0B73A',
          500: '#C99700',
          600: '#A37A00',
          700: '#7B5C00',
          soft: '#FBF4DE',
        },

        // Moss green — on-plan / healthy
        moss: {
          DEFAULT: '#3F7A52',
          50: '#EEF4EE',
          100: '#D7E5D8',
          500: '#3F7A52',
          700: '#2E5A3D',
          soft: '#E8F0E9',
        },

        // Aliases for compatibility with existing components
        good: {
          DEFAULT: '#3F7A52',
          soft: '#E8F0E9',
        },
        warn: {
          DEFAULT: '#A37A00',
          soft: '#FBF4DE',
        },
      },
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        mono: ['var(--font-inter)', 'ui-monospace', 'monospace'],
      },
      fontSize: {
        // refined display sizes for editorial KPIs
        kpi: ['2.25rem', { lineHeight: '1.05', letterSpacing: '-0.02em' }],
        hero: ['3.5rem', { lineHeight: '1', letterSpacing: '-0.03em' }],
        eyebrow: ['0.6875rem', { lineHeight: '1', letterSpacing: '0.08em' }],
      },
      borderRadius: {
        soft: '10px',
        card: '14px',
        pill: '999px',
      },
      boxShadow: {
        hairline: '0 0 0 1px #E8E1D3',
        card: '0 1px 0 0 rgba(23,21,19,0.04), 0 0 0 1px #E8E1D3',
        elevated: '0 8px 24px -12px rgba(23,21,19,0.18), 0 0 0 1px #E8E1D3',
        focus: '0 0 0 3px rgba(164,22,26,0.18)',
      },
      backgroundImage: {
        'grain': "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.09 0 0 0 0 0.08 0 0 0 0 0.07 0 0 0 0.04 0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>\")",
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'stripe-slide': {
          from: { backgroundPosition: '0 0' },
          to: { backgroundPosition: '40px 0' },
        },
      },
      animation: {
        'fade-in': 'fade-in 280ms cubic-bezier(0.2, 0.7, 0.2, 1) both',
        'stripe': 'stripe-slide 1.4s linear infinite',
      },
    },
  },
  plugins: [],
};

export default config;
