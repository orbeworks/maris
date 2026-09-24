export class TileJsonDto {
  tilejson!: "3.0.0";
  name!: string;
  version!: string;
  scheme!: "xyz";
  tiles!: string[];
  minzoom!: number;
  maxzoom!: number;
  bounds!: [number, number, number, number];
  vector_layers!: Array<{
    id: string;
    fields: Record<string, string>;
    minzoom: number;
    maxzoom: number;
  }>;
}
