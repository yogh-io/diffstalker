/**
 * Web UI entry point: create the Vue app, install Pinia, mount.
 * Stores and views land in later slices; this is the scaffold.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
