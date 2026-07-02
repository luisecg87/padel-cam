import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: funciona igual en local y en GitHub Pages (/padel-cam/)
  base: './',
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
});
