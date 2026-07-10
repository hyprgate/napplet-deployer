import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    nip5aManifest({
      nappletType: 'napplet-deployer',
      requires: ['identity', 'outbox', 'theme', 'upload'],
      artifactMode: 'single-file',
    }),
  ],
  resolve: { dedupe: ['svelte'] },
  server: { port: 9540, cors: true },
  build: { outDir: 'dist' },
});
