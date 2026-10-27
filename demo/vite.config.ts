import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Built with `vite build demo` from the repository root, so this directory is Vite's root and
// the output goes to demo/dist. The base path matches https://ult666666.github.io/searchlite/.
export default defineConfig({
  base: '/searchlite/',
  build: {
    target: 'es2022',
    rolldownOptions: {
      input: {
        search: resolve(import.meta.dirname, 'index.html'),
        relevance: resolve(import.meta.dirname, 'relevance.html'),
        local: resolve(import.meta.dirname, 'local.html'),
      },
    },
  },
});
