import Joi from 'joi';

export const envSchema = Joi.object({
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).required(),
  DATABASE_MIGRATIONS_RUN: Joi.boolean().default(true),
  ENC_PROCESSING_ENABLED: Joi.boolean().default(true),
  REDIS_URL: Joi.string().uri({ scheme: ['redis', 'rediss'] }).required(),
  HOST: Joi.string().default('0.0.0.0'),
  MAX_ARCHIVE_ENTRIES: Joi.number().integer().positive().default(50_000),
  MAX_UNCOMPRESSED_BYTES: Joi.number().integer().positive().default(5_368_709_120),
  MAX_UPLOAD_BYTES: Joi.number().integer().positive().default(1_073_741_824),
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3001),
  STORAGE_DIR: Joi.string().default('.storage'),
  CHART_STORAGE_DIR: Joi.string().default('.storage/chart-data'),
  CHART_STORAGE_BACKEND: Joi.string().valid('local', 's3').default('local'),
  CHART_ASSET_BASE_URL: Joi.string().uri().allow('').optional(),
  ENC_S3_ENDPOINT: Joi.string().uri().allow('').default(''),
  ENC_S3_REGION: Joi.string().default('auto'),
  ENC_S3_BUCKET: Joi.string().allow('').default(''),
  ENC_S3_ACCESS_KEY_ID: Joi.string().allow('').default(''),
  ENC_S3_SECRET_ACCESS_KEY: Joi.string().allow('').default(''),
  GFS_CACHE_DIR: Joi.string().default('.storage/gfs'),
  GFS_RUN_CACHE_TTL_MS: Joi.number().integer().positive().default(300_000),
  GFS_NEGATIVE_RUN_CACHE_TTL_MS: Joi.number()
    .integer()
    .positive()
    .default(180_000),
  GFS_PREFETCH_ENABLED: Joi.boolean().default(true),
  GFS_PREFETCH_REFRESH_INTERVAL_MS: Joi.number()
    .integer()
    .positive()
    .default(900_000),
  GFS_PREFETCH_CONCURRENCY: Joi.number().integer().min(1).max(16).default(6),
  GFS_PREFETCH_FORECAST_HOURS: Joi.string()
    .default("0"),
  GFS_PREFETCH_TILE_TTL_SECONDS: Joi.number()
    .integer()
    .positive()
    .default(1_800),
  GFS_PREFETCH_LOCK_TTL_MS: Joi.number()
    .integer()
    .positive()
    .default(120_000),
  GFS_PREFETCH_MAX_ESTIMATED_REDIS_BYTES: Joi.number()
    .integer()
    .positive()
    .default(1024 * 1024 * 1024),
  GFS_PARSER_PYTHON: Joi.string().default('python3'),
  GFS_PARSER_SCRIPT: Joi.string().default('apps/api/scripts/gfs-grib-parser.py'),
}).unknown(true);

export function validateEnv(config: Record<string, unknown>) {
  const { error, value } = envSchema.validate(config, { abortEarly: false });
  if (error) throw error;
  return value as Record<string, unknown>;
}
