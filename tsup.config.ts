import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: {
    compilerOptions: {
      // tsup 8 passes `baseUrl` to its declaration build, which TypeScript 6 reports as deprecated.
      // Silencing that one deprecation keeps the declaration build working until tsup is upgraded.
      ignoreDeprecations: '6.0',
    },
  },
  sourcemap: true,
  clean: true,
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
});
