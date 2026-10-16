// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://maxim.us.kg',
  trailingSlash: 'never',
  build: { format: 'file' },
});
