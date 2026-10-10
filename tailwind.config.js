export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#0b2a5b',
        brand: '#1d4ed8',
        accent: '#16a34a',
        ink: '#0f172a',
        mist: '#f1f5f9',
        pending: '#d97706',
        overdue: '#b91c1c',
        success: '#15803d',
      },
      fontFamily: {
        sans: ['"Source Sans 3"', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        card: '0 10px 30px -18px rgb(11 42 91 / 0.45)',
        lift: '0 16px 40px -24px rgb(11 42 91 / 0.55)',
      },
      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        marquee: {
          from: { transform: 'translateX(0)' },
          to: { transform: 'translateX(-50%)' },
        },
        shimmer: {
          from: { backgroundPosition: '-400px 0' },
          to: { backgroundPosition: '400px 0' },
        },
        'slide-in-left': {
          from: { transform: 'translateX(-100%)' },
          to: { transform: 'translateX(0)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.45s ease-out both',
        marquee: 'marquee 42s linear infinite',
        shimmer: 'shimmer 1.4s ease-in-out infinite',
        'slide-in-left': 'slide-in-left 0.28s ease-out both',
      },
    },
  },
  plugins: [],
}
