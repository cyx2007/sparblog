import { getCollection, type CollectionEntry } from 'astro:content';

export type Note = CollectionEntry<'notes'>;

// Keep visibility consistent across pages, search, RSS and the sitemap.
export async function getNotes() {
  const now = Date.now();
  return (await getCollection('notes'))
    .filter((note) => !note.data.draft && note.data.date.valueOf() <= now)
    .sort(
      (a, b) =>
        b.data.date.valueOf() - a.data.date.valueOf() ||
        a.id.localeCompare(b.id),
    );
}

export const dateLabel = (date: Date) => date.toISOString().slice(0, 10);
export const noteUrl = (id: string) =>
  `/notes/${id.split('/').map(encodeURIComponent).join('/')}/`;
export const categoryUrl = (category: string) =>
  `/category/${encodeURIComponent(category)}/`;
export const pageUrl = (page: number) => (page === 1 ? '/' : `/page/${page}/`);

export function getCategories(notes: Note[]) {
  return [...new Set(notes.map((note) => note.data.category))].map((name) => ({
    name,
    url: categoryUrl(name),
    count: notes.filter((note) => note.data.category === name).length,
  }));
}
