import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./src/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        cream: '#F5F1EA',
        surface: '#FFFFFF',
        ink: '#1A1A1A',
        muted: '#6B6B6B',
        hairline: '#E6E0D6',
        damm: {
          DEFAULT: '#A4161A',
          hover: '#7E1116',
          soft: '#FBEAEA',
        },
        good: {
          DEFAULT: '#2E7D32',
          soft: '#E6F2E7',
        },
        warn: {
          DEFAULT: '#B7791F',
          soft: '#FBF1DD',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      borderRadius: {
        soft: '10px',
      },
      boxShadow: {
        hairline: '0 0 0 1px #E6E0D6',
      },
    },
  },
  plugins: [],
};

export default config;
