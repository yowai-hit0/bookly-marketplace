import DefaultTheme from 'vitepress/theme'
import ApiReference from './ApiReference.vue'
import type { Theme } from 'vitepress'
import './custom.css'

// Extends the default theme with one component: the Scalar API reference,
// registered globally so `api/index.md` can drop it in.
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ApiReference', ApiReference)
  },
} satisfies Theme
