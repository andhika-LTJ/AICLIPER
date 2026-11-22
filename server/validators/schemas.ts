import { z } from 'zod';

export const ThemePresetSchema = z.enum([
  'minimal_light',
  'dark_studio',
  'creator_neon',
  'professional',
]);

export const ClippingApproachSchema = z.enum([
  'educational',
  'storytelling',
  'motivational',
  'informative',
  'entertainment',
  'promotional',
]);

export const SocialPlatformSchema = z.enum([
  'youtube_shorts',
  'tiktok',
  'instagram_reels',
  'facebook_reels',
  'x_twitter',
  'linkedin',
]);

export const HookStyleToneSchema = z.enum([
  'profesional',
  'edukatif',
  'storytelling',
  'emosional',
  'santai',
  'provokatif_etis',
]);

export const CreateWorkspaceSchema = z.object({
  name: z.string().trim().min(2, 'Nama workspace minimal 2 karakter.').max(64),
  description: z.string().trim().max(240).optional().default(''),
});

export const TimelineElementSchema = z.object({
  id: z.string().min(1).max(120),
  trackType: z.enum(['video', 'audio', 'text', 'subtitle']),
  label: z.string().min(1).max(160),
  startSec: z.number().min(0).max(14400),
  endSec: z.number().min(0.1).max(14400),
  sourceOffsetSec: z.number().min(0).max(86400).optional(),
  muted: z.boolean().optional(),
  locked: z.boolean().optional(),
  color: z.string().max(32).optional(),
  meta: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export const EditorExportPresetSchema = z.object({
  resolution: z.enum(['1080p', '4k']),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  format: z.literal('mp4_h264'),
  layout: z.enum([
    'full_16_9_focus',
    'shorts_studio_focus',
    'shorts_full_bleed',
    'square_1_1',
    'portrait_4_5',
    'vertical_9_16',
    'landscape_16_9',
  ]),
  normalizeAudio: z.boolean(),
  includeSubtitles: z.boolean(),
  includeIntro: z.boolean(),
});

export const SaveEditingProjectSchema = z.object({
  title: z.string().trim().min(1).max(160),
  durationSec: z.number().min(1).max(3600),
  zoomLevel: z.number().min(1).max(4),
  safeAreaEnabled: z.boolean(),
  elements: z.array(TimelineElementSchema).min(1).max(120),
  exportPreset: EditorExportPresetSchema,
  syncClipBounds: z.boolean().optional().default(true),
});

export const CreateTemplateSchema = z.object({
  name: z.string().trim().min(2, 'Nama template minimal 2 karakter.').max(80),
  category: z.enum(['subtitle', 'intro', 'thumbnail', 'export']),
  description: z.string().trim().max(240).optional().default(''),
  isPublic: z.boolean().optional().default(false),
  workspaceId: z.string().max(80).nullable().optional(),
  config: z.record(z.string(), z.unknown()),
});

export const CustomContentGenerationSchema = z.object({
  episodeId: z.string().max(120).optional().nullable(),
  clipId: z.string().max(120).optional().nullable(),
  kind: z.enum([
    'full_package',
    'script',
    'title_hook',
    'caption_cta',
    'description_hashtags',
  ]),
  language: z.enum(['id', 'en', 'bilingual']).default('id'),
  platform: SocialPlatformSchema.default('youtube_shorts'),
  tone: HookStyleToneSchema.default('edukatif'),
  audience: z.string().trim().min(2).max(120).default('Kreator & Profesional Muda'),
  objective: z
    .enum(['views', 'engagement', 'education', 'conversion', 'authority'])
    .default('engagement'),
  textLength: z.enum(['short', 'medium', 'long']).default('medium'),
  writingStyle: z
    .enum(['conversational', 'punchy', 'editorial', 'storyteller', 'analytical'])
    .default('conversational'),
  topicFocus: z.string().trim().max(280).optional(),
});

export const AdvisorAskSchema = z.object({
  question: z.string().trim().min(2, 'Pertanyaan minimal 2 karakter.').max(1000),
});

export const PlanCatalogItemSchema = z.object({
  tier: z.enum(['free', 'starter', 'pro', 'business']),
  label: z.string().trim().min(2).max(40),
  monthlyPriceIdr: z.number().int().min(0).max(50_000_000),
  monthlyAiLimit: z.number().int().min(1).max(100_000),
  monthlyRenderLimit: z.number().int().min(1).max(100_000),
  monthlyUploadLimit: z.number().int().min(1).max(100_000),
  maxExportQuality: z.enum(['1080p', '4k']),
  maxStorageMb: z.number().int().min(128).max(1_000_000),
  maxProjects: z.number().int().min(1).max(100_000),
  highlights: z.array(z.string().trim().min(1).max(120)).min(1).max(6),
});

export const UpdateSystemSettingsSchema = z.object({
  defaultAiModel: z.enum(['gemini-4-hydrogen', 'gemini-3.1-flash-lite']).optional(),
  fallbackAiModel: z.enum(['gemini-4-hydrogen', 'gemini-3.1-flash-lite']).optional(),
  maintenanceMode: z.boolean().optional(),
  allowNewRegistrations: z.boolean().optional(),
  defaultThemePreset: ThemePresetSchema.optional(),
  plans: z
    .object({
      free: PlanCatalogItemSchema,
      starter: PlanCatalogItemSchema,
      pro: PlanCatalogItemSchema,
      business: PlanCatalogItemSchema,
    })
    .optional(),
});

export function formatZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return 'Payload permintaan tidak valid.';
  const path = first.path.length > 0 ? `${first.path.join('.')}: ` : '';
  return `${path}${first.message}`;
}
