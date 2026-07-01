import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // ---- Black / ink: the canvas ----
        ink: '#0a0a0c',
        // ---- Gunmetal greys: elevated surfaces ----
        panel: '#15171c',
        'panel-2': '#1b1e24',
        edge: '#2a2e37',
        'edge-strong': '#3a3f4b',
        muted: '#9aa0ad',
        // ---- Gold: the single accent ----
        accent: '#d4af37',
        'accent-soft': '#e8c75a',
        'accent-dim': '#8a7320',
        // ---- Semantic finance tones (unchanged meaning, retuned for the warmer base) ----
        pos: '#3ecf8e',
        neg: '#f06a6a',
        warn: '#e0a93c',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'monospace'],
      },
      boxShadow: {
        card: '0 1px 0 0 rgba(212,175,55,0.06) inset, 0 8px 28px -14px rgba(0,0,0,0.7)',
      },
    },
  },
  plugins: [],
};

export default config;
