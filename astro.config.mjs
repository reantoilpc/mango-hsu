import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://mango-hsu.rayclaw-worker.workers.dev',
  vite: {
    plugins: [tailwindcss()],
  },
});
