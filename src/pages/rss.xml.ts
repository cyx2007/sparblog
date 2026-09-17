import type { APIRoute } from 'astro';
import { site } from '../data/site';
import { getNotes, noteUrl } from '../lib/notes';
import { escapeXml as xml } from '../lib/xml';

export const GET: APIRoute = async () => {
  const notes = (await getNotes()).filter((note) => !note.data.example);
  const items = notes
    .map((note) => {
      const url = xml(new URL(noteUrl(note.id), site.url).href);
      return `<item><title>${xml(note.data.title)}</title><link>${url}</link><guid isPermaLink="true">${url}</guid><description>${xml(note.data.description)}</description><pubDate>${note.data.date.toUTCString()}</pubDate><category>${xml(note.data.category)}</category></item>`;
    })
    .join('\n');
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>${xml(site.name)}</title><link>${site.url}/</link><description>${xml(site.description)}</description><language>zh-CN</language>
<atom:link href="${site.url}/rss.xml" rel="self" type="application/rss+xml" />
${items}</channel></rss>`,
    { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8' } },
  );
};
