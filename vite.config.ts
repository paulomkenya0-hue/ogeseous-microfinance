import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  /**
   * GitHub Pages serves this app from a sub-path, but Vercel, Netlify and Cloudflare serve it from
   * the domain root. The path used to be hard-coded to '/ogeseous-microfinance/', which meant the
   * build was only usable on one host: every asset URL 404'd anywhere else.
   *
   * Set VITE_BASE_PATH in the host's environment to override. Note that GitHub Pages also needs
   * public/404.html, which redirects unknown paths back into the app so a refresh on /admin/loans
   * works at all.
   */
  base: process.env.VITE_BASE_PATH || '/',

  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 400,
    rollupOptions: {
      output: {
        /**
         * Three long-lived chunks instead of one 861KB bundle. React and Supabase are needed on
         * every page, so they are worth splitting from app code: a student on the login screen does
         * not download the admin pages or the PDF library, and the browser caches these across
         * deploys.
         */
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          supabase: ['@supabase/supabase-js'],
        },
      },
    },
  },

  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})