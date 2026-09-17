import { defineConfig } from 'astro/config';
import { site } from './src/data/site.ts';

export default defineConfig({
  site: site.url,
  output: 'static',
  trailingSlash: 'always',
  redirects: Object.fromEntries([
    ['/compare/', '/'],
    ...['a', 'b', 'c'].flatMap((style) => [
      [`/${style}/`, '/'],
      [`/${style}/archive/`, '/archive/'],
      [`/${style}/about/`, '/about/'],
      [`/${style}/notes/[...slug]`, '/notes/[...slug]'],
    ]),
  ]),
  markdown: { shikiConfig: { theme: 'github-light' } },
  devToolbar: { enabled: false },
});
