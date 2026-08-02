import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The view-model persists the user's view mode and panel width, so the tests
    // need a real localStorage. Node alone gives `localStorage is not defined`.
    environment: 'happy-dom',
  },
});
