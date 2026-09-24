// Lower bounds, in the same descending order as the displayed legend.
const MINIMUM_SPEEDS = [32.6, 28.5, 24.5, 20.8, 17.2, 13.9, 10.8, 8, 5.5, 0];
export const METRES_PER_SECOND_TO_KNOTS = 1.943844492;

export function formatWindLegendLabel(label: string) {
  const prefix = label.startsWith('>') || label.startsWith('<') ? label[0] : '';
  const speed = Number(prefix ? label.slice(1) : label);
  return prefix + (Math.round(speed * METRES_PER_SECOND_TO_KNOTS * 10) / 10).toString();
}

export function windLegendBand(speed: number | null | undefined): number {
  if (speed == null || !Number.isFinite(speed) || speed < 0) return -1;
  return MINIMUM_SPEEDS.findIndex(minimum => speed >= minimum);
}
