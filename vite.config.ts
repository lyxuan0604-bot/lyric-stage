// Build config for Lyric Stage: Folia's visualizer driven by a YouTube player.
// Only the YouTube page (index.html -> src/youtube/main.tsx) is built; Folia's own app entry
// and its desktop / server parts are not part of this project.
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { commandPinyinPlugin } from './dev/pinyin/commandPinyinPlugin.mjs';
import { icuFoliaDataPlugin } from './dev/icuFolia/icuFoliaDataPlugin.mjs';
import { traditionalLocalePlugin } from './dev/i18n/traditionalLocalePlugin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: '/',
  worker: { format: 'es' },
  plugins: [commandPinyinPlugin(), traditionalLocalePlugin(), icuFoliaDataPlugin(), react()],
  define: {
    __COMMIT_HASH__: JSON.stringify('lyric-stage'),
    __GIT_BRANCH__: JSON.stringify('main'),
    __BUILD_REPO__: JSON.stringify('lyric-stage'),
    __BUILD_COMMIT__: JSON.stringify(''),
    __BUILD_KIND__: JSON.stringify('web'),
    __BUILD_HOST__: JSON.stringify(''),
    __APP_VERSION__: JSON.stringify('0.1.0'),
    __APP_VERSION_LABEL__: JSON.stringify('Lyric Stage 0.1.0'),
    __APP_RELEASE_CHANNEL__: JSON.stringify('stable'),
    __DOCKER_STACK_VERSION__: JSON.stringify(''),
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 4000,
    rollupOptions: { input: { main: 'index.html' } },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
});
