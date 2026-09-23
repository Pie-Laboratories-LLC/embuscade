import { defineConfig } from 'vite';

// `vite` (dev) serves index.html -> src/standalone.js as before.
// `vite build` produces the embeddable library instead: dist/embuscade.js
// (an ES module exporting mount -- see src/main.js) plus
// dist/embuscade.css, which the host page loads with its own <link>.
// @bolo/shared is bundled in, so dist/ is self-contained.
export default defineConfig({
  server: {
    port: 5174
  },
  build: {
    lib: {
      entry: 'src/main.js',
      formats: ['es'],
      fileName: () => 'embuscade.js'
    },
    rollupOptions: {
      output: {
        assetFileNames: 'embuscade.[ext]'
      }
    }
  }
});
