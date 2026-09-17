import type { APIRoute } from 'astro';
import { site } from '../data/site';
import { getNotes, getCategories, noteUrl, pageUrl } from '../lib/notes';
import { escapeXml as xml } from '../lib/xml';

export const GET: APIRoute = async () => {
  const allNotes = await getNotes();
  const notes = allNotes.filter((note) => !note.data.example);
  const pages: { path: string; updated?: Date }[] = [{ path: '/about/' }];
  if (notes.length) pages.push({ path: '/archive/' });
  for (let index = 0; index < allNotes.length; index += site.pageSize) {
    if (
      allNotes
        .slice(index, index + site.pageSize)
        .some((note) => !note.data.example)
    ) {
      pages.push({ path: pageUrl(index / site.pageSize + 1) });
    }
  }
  pages.push(
    ...getCategories(notes).map((category) => ({ path: category.url })),
  );
  pages.push(
    ...notes.map((note) => ({
      path: noteUrl(note.id),
      updated: note.data.updated ?? note.data.date,
    })),
  );
  const urls = pages
    .map(
      (page) =>
        `<url><loc>${xml(new URL(page.path, site.url).href)}</loc>${page.updated ? `<lastmod>${page.updated.toISOString()}</lastmod>` : ''}</url>`,
    )
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`,
    {
      headers: { 'Content-Type': 'application/xml; charset=utf-8' },
    },
  );
};
