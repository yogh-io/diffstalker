/**
 * Web UI entry point: install the generated theme stylesheet, create the
 * Vue app, install Pinia, mount. The theme attribute itself is stamped in
 * App setup (uiStore.init) so tests mounting App get it too.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { installThemeStyles } from './theme/css';
import './style.css';

installThemeStyles();

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
