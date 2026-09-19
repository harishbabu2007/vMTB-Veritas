/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      fontFamily: {
        sans: [
          'Manrope',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'sans-serif',
          '"Apple Color Emoji"',
          '"Segoe UI Emoji"',
          '"Segoe UI Symbol"',
        ],
      },
      colors: {
        bg: 'var(--color-bg)',
        surface: 'var(--color-surface)',
        text: 'var(--color-text)',
        'text-muted': 'var(--color-text-muted)',
        border: 'var(--color-border)',
        primary: 'var(--color-primary)',
        'primary-hover': 'var(--color-primary-hover)',
        'status-processing-bg': 'var(--color-status-processing-bg)',
        'status-processing-text': 'var(--color-status-processing-text)',
        'status-pending-bg': 'var(--color-status-pending-bg)',
        'status-pending-text': 'var(--color-status-pending-text)',
        'status-verified-bg': 'var(--color-status-verified-bg)',
        'status-verified-text': 'var(--color-status-verified-text)',
        'status-failed-bg': 'var(--color-status-failed-bg)',
        'status-failed-text': 'var(--color-status-failed-text)',
        'status-mtb-updated-bg': 'var(--color-status-mtb-updated-bg)',
        'status-mtb-updated-text': 'var(--color-status-mtb-updated-text)',
      },
    },
  },
  plugins: [],
};
