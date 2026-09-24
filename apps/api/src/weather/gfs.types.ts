export type GfsFieldName =
  | "windU"
  | "windV"
  | "temperature"
  | "precipitation"
  | "precipitationRate"
  | "cloudCover"
  | "pressure"
  | "gust"
  | "humidity";

export type GfsBounds = {
  north: number;
  south: number;
  east: number;
  west: number;
};

export type GfsRun = {
  date: string;
  cycle: number;
  run: string;
  runAt: string;
};

export type GfsGrid = {
  model: "gfs";
  run: string;
  forecastTime: string;
  forecastHour: number;
  resolution: 0.25;
  bounds: GfsBounds;
  width: number;
  height: number;
  gridOrder: "north-to-south,west-to-east";
  longitudeConvention: "-180..180";
  units: {
    wind: "m/s";
    temperature: "K";
    precipitation: "kg/m2";
    precipitationRate: "kg/m2/s";
    cloudCover: "%";
    pressure: "Pa";
    gust: "m/s";
    humidity: "%";
  };
  fields: Partial<Record<GfsFieldName, Array<number | null>>>;
};
