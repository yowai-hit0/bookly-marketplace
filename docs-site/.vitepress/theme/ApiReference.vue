<script setup lang="ts">
// Embeds the standalone Redoc reference (built to /api-reference.html by
// scripts/bundle-openapi.mjs) in a full-height frame. Redoc renders in its own
// document, so its styles never fight VitePress and it keeps its own operation
// list, search and deep links. The page uses VitePress's `page` layout, so this
// frame gets the full width below the top nav.
import { withBase } from 'vitepress'

const src = withBase('/api-reference.html')
</script>

<template>
  <iframe
    :src="src"
    class="api-reference-frame"
    title="Bookly API reference"
    loading="lazy"
  />
</template>

<style scoped>
.api-reference-frame {
  display: block;
  border: 0;
  width: 100%;
  /* Fill the viewport below the top nav. */
  height: calc(100vh - var(--vp-nav-height, 64px));
}
</style>
