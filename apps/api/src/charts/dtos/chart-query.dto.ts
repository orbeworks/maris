import { BadRequestException } from "@nestjs/common";

export class ChartQueryDto {
  constructor(
    public lat: number,
    public lon: number,
    public version?: string,
  ) {}

  static parse(query: Record<string, unknown>): ChartQueryDto {
    const number = (value: unknown, limit: number) => {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        !Number.isFinite(Number(value)) ||
        Math.abs(Number(value)) > limit
      ) {
        throw new BadRequestException("Valid lat and lon are required");
      }

      return Number(Number(value).toFixed(5));
    };

    const lat = number(query.lat, 90);
    const lon = number(query.lon, 180);

    if (
      query.version !== undefined &&
      (typeof query.version !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(query.version))
    ) {
      throw new BadRequestException("Invalid chart version");
    }

    return new ChartQueryDto(lat, lon, query.version as string | undefined);
  }
}
