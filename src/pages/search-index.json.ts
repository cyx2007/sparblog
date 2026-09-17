import type { APIRoute } from 'astro';
import { getNotes, noteUrl, dateLabel } from '../lib/notes';

export const GET: APIRoute = async () =>
  Response.json(
    (await getNotes()).map((note) => ({
      title: note.data.title,
      url: noteUrl(note.id),
      date: dateLabel(note.data.date),
      category: note.data.category,
      example: note.data.example,
      text: `${note.data.description}\n${note.body ?? ''}`,
    })),
  );
