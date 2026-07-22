/**
 * Web UI entry point: install the generated theme stylesheet, create the
 * Vue app, install Pinia, mount. The theme attribute itself is stamped in
 * App setup (uiStore.init) so tests mounting App get it too.
 *
 * Dev-only escape hatch: `?harness=diff` mounts the DiffStack churn
 * harness (src/dev/DiffChurnHarness.vue) instead of App — an isolated
 * soak rig for the scroll-anchoring sandwich. The branch is statically
 * dead in production builds (import.meta.env.DEV), so neither the
 * harness nor its chunk ever ships.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { installThemeStyles } from './theme/css';
import './style.css';
import './theme/hljs.css';

async function bootstrap(): Promise<void> {
  installThemeStyles();

  if (import.meta.env.DEV && location.search.includes('harness=diff')) {
    const { default: DiffChurnHarness } = await import('./dev/DiffChurnHarness.vue');
    createApp(DiffChurnHarness).mount('#app');
    return;
  }

  const app = createApp(App);
  app.use(createPinia());
  app.mount('#app');
}

void bootstrap();
