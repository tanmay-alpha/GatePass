import { z } from 'zod';

const envSchema = z.object({
  ADMIN_TOKEN: z
    .string({ error: 'ADMIN_TOKEN is required. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"' })
    .min(24, 'ADMIN_TOKEN must be at least 24 characters'),
  APP_PUBLIC_URL: z
    .url({ protocol: /^https?$/, error: 'APP_PUBLIC_URL must be an http(s) URL' })
    .default('http://localhost:3000')
    .transform((value) => value.replace(/\/+$/, '')),
  DATABASE_FILE: z.string().min(1).default('.local/data/gatepass.db'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Express `trust proxy`: number of proxy hops (e.g. 1 behind Caddy, 2 behind
   * Vercel + Caddy) or an address/subnet list. Unset = trust nothing. `true`
   * is refused: it trusts any client-supplied X-Forwarded-For, which lets
   * clients choose their own rate-limit bucket.
   */
  TRUST_PROXY: z
    .string()
    .refine((value) => value !== 'true', 'TRUST_PROXY=true trusts spoofed X-Forwarded-For; set the hop count (e.g. 1) instead')
    .optional(),
  /** Shared secret a fronting CDN adds as X-Origin-Secret; requests without it are refused. */
  ORIGIN_SECRET: z.string().min(32, 'ORIGIN_SECRET must be at least 32 characters').optional(),
  CLIENT_DIR: z.string().default('dist/client'),
  HTTPS_CERT_FILE: z.string().optional(),
  HTTPS_KEY_FILE: z.string().optional()
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Treat empty strings from .env files as unset.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''));
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((issue) => `  - ${issue.message}`).join('\n')}`);
  }
  return parsed.data;
}

/** Express accepts numbers or address lists for `trust proxy`. */
export function trustProxySetting(value: string | undefined): number | string | boolean {
  if (value === undefined || value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
