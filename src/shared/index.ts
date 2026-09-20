export {
  SourceStatus,
  SOURCE_STATUSES,
  parsePath,
  readPath,
  normalizeJsonLike,
  roundTripJson,
  writePath,
  assertSafeToken,
  type PathToken,
  type ReadResult,
} from './presence.js';

export {coerce, type CoerceType, type CoerceResult} from './coerce.js';

export {
  NullStrategy,
  compileRules,
  convertFieldInto,
  convertRecord,
  convertBatch,
  emptyStatusCounts,
  emptyOutcomeCounts,
  type FieldRule,
  type FieldResult,
  type FieldCounts,
  type Outcome,
  type ConvertRecordResult,
  type BatchSummary,
  type BatchResult,
  type ConvertOptions,
  type CompiledRule,
} from './convert.js';

export {
  MIGRATION_VERSION,
  isLegacyResult,
  migrateLegacyField,
  migrateSavedResult,
  stampVersion,
  type LegacyField,
  type LegacyRecord,
  type LegacySavedResult,
  type MigrateOptions,
} from './migrate.js';
