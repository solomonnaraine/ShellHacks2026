import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  optimizeDeps: {
    include: ['frame-ticker', 'tinycolor2', 'h3-js', 'simplesignal', 'prop-types'],
    exclude: ['react-resizable-panels', 'react-globe.gl', 'react-kapsule'],
  },
})
