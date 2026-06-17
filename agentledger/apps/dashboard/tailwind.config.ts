import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#0b0e14',
        panel: '#11151d',
        edge: '#1e2530',
        muted: '#8b95a5',
        accent: '#4f8cff',
      },
    },
  },
  plugins: [],
};

export default config;
