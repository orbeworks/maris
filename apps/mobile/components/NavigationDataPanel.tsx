import { SymbolView } from "expo-symbols";
import { useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  getAndroidWeatherSymbol,
  iosWeatherIcons,
  weatherIconFromGfs,
} from "../weather/weather-icons";
import { BlurPanel } from "./BlurPanel";
import { BlurText } from "./BlurText";
import { LoadingIcon } from "./LoadingIcon";
import { METRES_PER_SECOND_TO_KNOTS } from "./wind-legend-band";
import {
  precipitationRateMillimetresPerHour,
  temperatureCelsius,
  windCardinal,
  windDirectionDegrees,
  windSpeedKt,
  type SampledGfsValues,
} from "../weather/gfs-grid";

type GfsConditionsSample = SampledGfsValues & { forecastTime?: string };

export type DataPanelItem = {
  label: string;
  value: string;
  unit: string;
  iosIcon: string;
  androidIcon: string;
  loading?: boolean;
};

const NAVIGATION_DATA: DataPanelItem[] = [
  { label: "SOG", value: "8.4", unit: "kt", iosIcon: "gauge.open.with.lines.needle.33percent", androidIcon: "speed_2" },
  { label: "COG", value: "132°", unit: "", iosIcon: "location.north", androidIcon: "navigation" },
  { label: "Heading", value: "128°", unit: "", iosIcon: "location.north.line", androidIcon: "near_me" },
  { label: "Depth", value: "12.6", unit: "m", iosIcon: "water.waves.and.arrow.trianglehead.down", androidIcon: "waves" },
  { label: "Draft", value: "1.7", unit: "m", iosIcon: "arrow.down.to.line", androidIcon: "vertical-align-bottom" },
  { label: "UKC", value: "10.9", unit: "m", iosIcon: "arrow.up.and.down", androidIcon: "height" },
];

const WEATHER_CONDITIONS_DATA: DataPanelItem[] = [
  { label: "Weather", value: "—", unit: "C", iosIcon: "cloud", androidIcon: "cloud" },
  { label: "Rain", value: "—", unit: "", iosIcon: "drop", androidIcon: "water_drop" },
  { label: "Wind", value: "8.4", unit: "kt", iosIcon: "wind", androidIcon: "air" },
  { ...NAVIGATION_DATA[2], label: "Waves", iosIcon: "water.waves", androidIcon: "tsunami" },
  { ...NAVIGATION_DATA[3], label: "Current", iosIcon: "arrow.trianglehead.2.clockwise.rotate.90", androidIcon: "Sync" },
  { ...NAVIGATION_DATA[4], label: "Tide", iosIcon: "water.waves.and.arrow.up", androidIcon: "water_lux" },
];

export function NavigationDataPanel({
  speed,
  cog,
  heading,
}: {
  speed?: number | null;
  cog?: number | null;
  heading?: number | null;
}) {
  const hasSpeed =
    typeof speed === "number" && Number.isFinite(speed) && speed >= 0;
  const hasCog =
    typeof cog === "number" && Number.isFinite(cog) && cog >= 0 && cog < 360;
  const hasHeading =
    typeof heading === "number" &&
    Number.isFinite(heading) &&
    heading >= 0 &&
    heading < 360;
  const items = NAVIGATION_DATA.map((item, index) => {
    if (index === 0) {
      return {
        ...item,
        value: hasSpeed
          ? (speed * METRES_PER_SECOND_TO_KNOTS).toFixed(1)
          : "—",
        loading: !hasSpeed,
      };
    }
    if (index === 1) {
      return {
        ...item,
        value: hasCog ? `${Math.round(cog)}°` : "—",
        loading: !hasCog,
      };
    }
    if (index === 2) {
      return {
        ...item,
        value: hasHeading ? `${Math.round(heading)}°` : "—",
        loading: !hasHeading,
      };
    }
    return item;
  });

  return <DataMetricsPanel items={items} />;
}

export function GfsConditionsPanel({ sample }: { sample?: GfsConditionsSample }) {
  const u = sample?.windU ?? null;
  const v = sample?.windV ?? null;
  const windKt = windSpeedKt(u, v);
  const direction = windDirectionDegrees(u, v);
  const cardinal = windCardinal(direction);
  const hasWind = windKt !== null && direction !== null && cardinal !== null;
  const rainRateMmH = precipitationRateMillimetresPerHour(sample?.precipitationRate ?? null);
  const forecastHour = sample?.forecastTime
    ? new Date(sample.forecastTime).getHours()
    : null;
  const isDay = forecastHour === null ? null : forecastHour >= 6 && forecastHour < 18;
  const gfsWeatherIcon = weatherIconFromGfs(
    sample?.cloudCover,
    rainRateMmH,
    sample?.temperature,
    isDay,
  ) ?? "BROKEN_CLOUDS";
  const weather = {
    ...WEATHER_CONDITIONS_DATA[0],
    value: temperatureCelsius(sample?.temperature ?? null)?.toFixed(0) ?? "",
    unit: "°C",
    iosIcon: iosWeatherIcons[gfsWeatherIcon],
    androidIcon: getAndroidWeatherSymbol(gfsWeatherIcon),
    loading: temperatureCelsius(sample?.temperature ?? null) === null,
  };
  const rain = {
    ...WEATHER_CONDITIONS_DATA[1],
    value: rainRateMmH?.toFixed(1) ?? "",
    unit: "mm/h",
    loading: rainRateMmH === null,
  };
  const items: DataPanelItem[] = [
    weather,
    rain,
    {
      ...WEATHER_CONDITIONS_DATA[2],
      value: hasWind ? `${windKt.toFixed(0)} · ${cardinal}` : "",
      unit: hasWind ? "kt" : "",
      loading: !hasWind,
    },
    WEATHER_CONDITIONS_DATA[3],
    WEATHER_CONDITIONS_DATA[4],
    WEATHER_CONDITIONS_DATA[5],
  ];

  return <DataMetricsPanel items={items} />;
}

function DataMetricsPanel({ items }: { items: DataPanelItem[] }) {
  const [itemWidths, setItemWidths] = useState<Record<string, number>>({});

  const updateItemWidth = (label: string, width: number) => {
    setItemWidths((previous) =>
      previous[label] === width ? previous : { ...previous, [label]: width },
    );
  };

  return (
    <BlurPanel flexDirection="row" alignSelf="stretch" style={styles.panel}>
      {items.map((item, index) => (
        <View
          key={item.label}
          onLayout={({ nativeEvent }) => updateItemWidth(item.label, nativeEvent.layout.width)}
          style={[styles.item, index < items.length - 1 && styles.divider]}
        >
          <SymbolView
            name={{ ios: item.iosIcon, android: item.androidIcon, web: item.androidIcon } as never}
            size={22}
            tintColor="#FFFFFF"
            type="hierarchical"
          />
          <BlurText style={styles.label} numberOfLines={1}>{item.label}</BlurText>
          <LoadingIcon loading={item.loading ?? false} size={22}>
            <BlurText
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.35}
              ellipsizeMode="clip"
              style={[
                styles.value,
                { fontSize: valueFontSize(item.value, itemWidths[item.label]) },
              ]}
            >
              {item.value}
            </BlurText>
          </LoadingIcon>
          <BlurText style={styles.unit}>{item.unit || "\u00A0"}</BlurText>
        </View>
      ))}
    </BlurPanel>
  );
}

function valueFontSize(value: string, itemWidth?: number) {
  const baseSize = 20;
  if (!itemWidth || value.length === 0) return baseSize;

  // Conservative average glyph width. This leaves room for separators and
  // platform font differences before Text's final fit-to-width adjustment.
  const availableWidth = Math.max(1, itemWidth - 4);
  const estimatedSize = availableWidth / (value.length * 0.62);
  return Math.max(9, Math.min(baseSize, estimatedSize));
}

const styles = StyleSheet.create({
  panel: {
    width: "100%",
    paddingHorizontal: 4,
    paddingVertical: 8,
    gap: 0,
  },
  item: {
    flex: 1,
    minWidth: 0,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    paddingHorizontal: 2,
  },
  divider: {
    borderRightWidth: 1,
    borderRightColor: "rgba(255, 255, 255, 0.22)",
  },
  label: {
    fontSize: 11,
    fontWeight: "400",
    lineHeight: 14,
  },
  value: {
    width: "100%",
    flexShrink: 1,
    fontSize: 20,
    fontWeight: "600",
    lineHeight: 22,
    textAlign: "center",
  },
  unit: {
    fontSize: 11,
    fontWeight: "400",
    lineHeight: 14,
  },
});
