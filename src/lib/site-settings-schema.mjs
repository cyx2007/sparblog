import { z } from 'astro/zod';

export const siteSettingsSchema = z
  .object({
    description: z.string().trim().min(1).max(240),
    about: z.string().max(100_000),
  })
  .strict();
