import { defineConfig } from 'vite';
import netlify from '@netlify/vite-plugin';
export default defineConfig(({ command }) => ({
  plugins: command === 'serve' && process.env.MOLT_STUDIO_TEST !== '1' ? [netlify()] : [],
  build: { outDir: 'dist', sourcemap: false },
}));
