import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0e14',
        panel: '#11151d',
        'panel-2': '#151b25',
        edge: '#1e2530',
        muted: '#8b95a5',
        accent: '#4f8cff',
        // Semantic finance tones: gains, losses, caution.
        pos: '#34d399',
        neg: '#fb7185',
        warn: '#fbbf24',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(255,255,255,0.03) inset, 0 8px 24px -12px rgba(0,0,0,0.6)',
      },
    },
  },
  plugins: [],
};

export default config;
