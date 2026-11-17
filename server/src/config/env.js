import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

// Resolve this file from server/.env even when the server is launched from the
// repository root or by a process manager with a different working directory.
dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });

export function validateOpenRouterConfig(settings) {
  if (!settings.openRouterKey?.trim()) return { ok: false, code: 'AI_NOT_CONFIGURED' };
  if (!settings.openRouterModel?.trim()) return { ok: false, code: 'MODEL_NOT_CONFIGURED' };
  const models = [settings.openRouterModel, ...(settings.fallbackModels || [])].map(x => x.trim()).filter(Boolean);
  if (models.some(model => !/^[\w.-]+\/[\w.-]+(?::[\w.-]+)?$/.test(model))) {
    return { ok: false, code: 'INVALID_MODEL_ID' };
  }
  return { ok: true, models: [...new Set(models)] };
}

export const config = {
  port: Number(process.env.PORT || 5000), clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 20), maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS || 2048),
  dbPath: process.env.DATABASE_PATH || './data/briefora.db', openRouterKey: process.env.OPENROUTER_API_KEY || '',
  openRouterModel: process.env.OPENROUTER_MODEL || '', fallbackModels: (process.env.OPENROUTER_FALLBACK_MODELS || '').split(',').map(x => x.trim()).filter(Boolean),
  sarvamKey: process.env.SARVAM_API_KEY || '', sarvamModel: process.env.SARVAM_TRANSLATION_MODEL || 'sarvam-translate:v1'
};
