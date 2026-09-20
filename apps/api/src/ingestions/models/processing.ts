export const INGESTION_STATUSES = [
  'received',
  'validating',
  'processing',
  'ready',
  'failed',
  'published',
] as const;

export type IngestionStatus = (typeof INGESTION_STATUSES)[number];

export type ProcessedCell = {
  edition: string | null;
  name: string;
  updateNumber: number;
  updatesApplied: number[];
  // Optional for versions imported before metadata extraction was introduced.
  metadata?: EncCellMetadata;
};

export type EncJsonValue = string | number | boolean | null | EncJsonValue[] | { [key: string]: EncJsonValue };

export type EncMetadataFeature = {
  type: 'Feature';
  properties: Record<string, EncJsonValue>;
  geometry: { type: string; coordinates?: EncJsonValue; geometries?: EncJsonValue[] } | null;
};

export type EncCellMetadata = {
  source: string | null;
  agencyCode: number | null;
  issueDate: string | null;
  updateApplicationDate: string | null;
  compilationScale: number | null;
  horizontalDatum: number | null;
  verticalDatum: number | null;
  soundingDatum: number | null;
  coveredAreaNames: string[];
  coverage: EncMetadataFeature[];
  // Keep spatial attribution: quality, datum and survey sources can vary by area.
  metaObjects: Record<string, EncMetadataFeature[]>;
  rawDatasetIdentification: Record<string, EncJsonValue>;
};

export type ProcessingResult = {
  bounds: [number, number, number, number];
  cells: ProcessedCell[];
  manifestPath: string;
  storagePath: string;
  artifactObjectKey?: string;
  manifestObjectKey?: string;
};

export type ProcessingShard = ProcessingResult & {
  sequence: number;
  shardKey: string;
};

export type ProcessingJob = {
  archivePath: string;
  ingestionId: string;
  versionId: string;
  versionKey: string;
};
