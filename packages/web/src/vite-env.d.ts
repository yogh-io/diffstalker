/// <reference types="vite/client" />

// No `declare module '*.vue'` shim: vue-tsc resolves SFCs natively and gives
// real per-component types. A global wildcard would flatten every .vue import
// to a loose type and hide type errors in `<script setup>` blocks.
