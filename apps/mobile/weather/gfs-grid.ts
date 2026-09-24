export type GfsBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type MapCenter = [longitude: number, latitude: number];

export type GfsGrid = {
  model: 'gfs';
  run: string;
  forecastTime: string;
  forecastHour: number;
  resolution: number;
  bounds: GfsBounds;
  width: number;
  height: number;
  longitudeConvention: '-180..180';
  gridOrder?: 'north-to-south,west-to-east';
  units: {
    wind: 'm/s';
    temperature: 'K';
    precipitation: 'kg/m2';
    precipitationRate: 'kg/m2/s';
    cloudCover: '%';
    pressure: 'Pa';
    gust: 'm/s';
    humidity: '%';
  };
  fields: Partial<Record<GfsFieldName, Array<number | null>>>;
};

export type GfsFieldName =
  | 'windU'
  | 'windV'
  | 'temperature'
  | 'precipitation'
  | 'precipitationRate'
  | 'cloudCover'
  | 'pressure'
  | 'gust'
  | 'humidity';

export type GfsPackage = {
  model: 'gfs';
  run: {
    date: string;
    cycle: number;
    run: string;
    runAt: string;
  };
  resolution: number;
  bounds: GfsBounds;
  forecastHours: number[];
  availableForecastHours: number[];
  grids: Record<string, GfsGrid>;
};

export type SampledGfsValues = Partial<
  Record<GfsFieldName, number | null>
>;

function isFiniteNumber(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeLongitude(longitude: number) {
  return ((((longitude + 180) % 360) + 360) % 360) - 180;
}

function sampleField(grid: GfsGrid, field: string, latitude: number, longitude: number) {
  const values = grid.fields[field as GfsFieldName];
  if (!values || values.length !== grid.width * grid.height) return null;

  const normalizedLongitude = normalizeLongitude(longitude);
  const { west, east, north, south } = grid.bounds;
  if (
    latitude < south || latitude > north ||
    normalizedLongitude < west || normalizedLongitude > east
  ) return null;

  const x = Math.max(0, Math.min(grid.width - 1,
    ((normalizedLongitude - west) / (east - west)) * (grid.width - 1)));
  const y = Math.max(0, Math.min(grid.height - 1,
    ((north - latitude) / (north - south)) * (grid.height - 1)));
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(grid.width - 1, x0 + 1);
  const y1 = Math.min(grid.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const topLeft = values[y0 * grid.width + x0];
  const topRight = values[y0 * grid.width + x1];
  const bottomLeft = values[y1 * grid.width + x0];
  const bottomRight = values[y1 * grid.width + x1];

  if (![topLeft, topRight, bottomLeft, bottomRight].every(isFiniteNumber)) return null;
  return (
    topLeft! * (1 - tx) * (1 - ty) +
    topRight! * tx * (1 - ty) +
    bottomLeft! * (1 - tx) * ty +
    bottomRight! * tx * ty
  );
}

/** Samples every available scalar/vector component using bilinear interpolation. */
export function sampleGridAtCoordinate(
  grid: GfsGrid,
  latitude: number,
  longitude: number,
): SampledGfsValues | null {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const result: SampledGfsValues = {};
  for (const field of Object.keys(grid.fields) as GfsFieldName[]) {
    result[field] = sampleField(grid, field, latitude, longitude);
  }
  return Object.keys(result).length && Object.values(result).some(isFiniteNumber)
    ? result
    : null;
}

export function sampleGridFieldAtCoordinate(
  grid: GfsGrid,
  field: string,
  latitude: number,
  longitude: number,
) {
  return sampleField(grid, field, latitude, longitude);
}

export function windSpeedKt(u: number | null, v: number | null) {
  if (!isFiniteNumber(u) || !isFiniteNumber(v)) return null;
  return Math.hypot(u, v) * 1.94384;
}

/** Meteorological direction: the direction the wind comes from. */
export function windDirectionDegrees(u: number | null, v: number | null) {
  if (!isFiniteNumber(u) || !isFiniteNumber(v) || Math.hypot(u, v) === 0) return null;
  return (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
}

export function windCardinal(direction: number | null) {
  if (!isFiniteNumber(direction)) return null;
  return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(direction / 45) % 8];
}

export function temperatureCelsius(kelvin: number | null) {
  return isFiniteNumber(kelvin) ? kelvin - 273.15 : null;
}

export function precipitationRateMillimetresPerHour(rate: number | null) {
  return isFiniteNumber(rate) ? rate * 3_600 : null;
}

export function pressureHpa(pascal: number | null) {
  return isFiniteNumber(pascal) ? pascal / 100 : null;
}

export function gustKt(gustMps: number | null) {
  return isFiniteNumber(gustMps) ? gustMps * 1.94384 : null;
}
