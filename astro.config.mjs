import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  site: 'https://mango-hsu.pages.dev',
  vite: {
    plugins: [tailwindcss()],
  },
});
