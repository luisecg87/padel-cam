import { defineConfig } from 'vite';

export default defineConfig({
  // Rutas relativas: funciona igual en local y en GitHub Pages (/padel-cam/)
  base: './',
  server: {
    port: Number(process.env.PORT) || 5173,
    strictPort: false,
  },
  // es2022: necesario para el top-level await del import() dinámico de
  // Three.js en main.ts (carga el spike solo cuando se pide ?renderer=three).
  build: {
    target: 'es2022',
  },
});
