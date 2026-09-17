import { z } from 'astro/zod';

// Shared by Astro and the administration API.
export const noteSchema = z
  .object({
    title: z.string().trim().min(1),
    description: z.string().trim().min(1),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    category: z
      .string()
      .trim()
      .min(1)
      .regex(/^[^/\\?#<>]+$/)
      .refine((value) => value !== '.' && value !== '..', 'Invalid category'),
    excerpt: z.array(z.string().trim().min(1)).optional(),
    draft: z.boolean().default(false),
    example: z.boolean().default(false),
  })
  .refine((note) => !note.updated || note.updated >= note.date, {
    message: 'updated must be on or after date',
    path: ['updated'],
  });
