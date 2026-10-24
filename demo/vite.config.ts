import { defineConfig } from 'vite';

// Built with `vite build demo` from the repository root, so this directory is Vite's root and
// the output goes to demo/dist. The base path matches https://ult666666.github.io/searchlite/.
export default defineConfig({
  base: '/searchlite/',
  build: { target: 'es2022' },
});
