export type ChartInformationDto = {
  id: string;
  name: string;
  source: string | null;
  edition: string | null;
  updateNumber: number;
  updatesApplied: number[];
  issueDate: string | null;
  updateApplicationDate: string | null;
  compilationScale: number | null;
  coveredAreaNames: string[];
  horizontalDatum: number | null;
  soundingDatum: number | null;
  verticalDatum: number | null;
  dataQuality: number[];
  surveys: {
    objectClass: string;
    source: string | null;
    date: string | null;
    startedAt: string | null;
    endedAt: string | null;
  }[];
  version: string;
  processedAt: string | null;
  publishedAt: string | null;
  coordinate: [number, number];
};
