import MaterialCommunityIcons from "@expo/vector-icons/MaterialCommunityIcons";
import FontAwesome6 from "@expo/vector-icons/FontAwesome6";
import { SymbolView } from "expo-symbols";
import { useState } from "react";
import {
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { usePanelTransition } from "./use-panel-transition";
import { LoadingIcon } from "./LoadingIcon";

import { BLUR_PANEL_GAP, BLUR_PANEL_ICON_SIZE, BlurPanel } from "./BlurPanel";

type MapControlsPanelProps = {
  locationActive: boolean;
  courseUp: boolean;
  onLocate: () => void;
  onMapPress: () => void;
  onMapModeChange?: (mode: MapStyleMode) => void;
  mapLoading?: boolean;
  showMapButton?: boolean;
};

export type MapStyleMode = "bright" | "satellite";

const MAP_STYLE_AFTER_PRESS: MapStyleMode[] = [
  "satellite",
  "bright",
];

export function MapControlsPanel({
  locationActive,
  courseUp,
  onLocate,
  onMapPress,
  onMapModeChange,
  mapLoading = false,
  showMapButton = true,
}: MapControlsPanelProps) {
  const isAndroid = Platform.OS === "android";
  const [iconIndex, setIconIndex] = useState(0);
  const reveal = usePanelTransition(showMapButton ? 1 : 0);
  const globeAccessibilityLabel =
    iconIndex === 0
      ? "Show satellite map"
      : "Show bright map";

  return (
    <BlurPanel alignSelf="flex-end">
      <View style={styles.controls}>
        <Pressable
          accessibilityLabel="Center on my location"
          accessibilityRole="button"
          onPress={onLocate}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          {isAndroid ? (
            <MaterialCommunityIcons
              color="#FFFFFF"
              name={
                courseUp
                  ? "navigation"
                  : locationActive
                    ? "near-me"
                    : "navigation-variant-outline"
              }
              size={BLUR_PANEL_ICON_SIZE}
            />
          ) : (
            <SymbolView
              name={
                courseUp
                  ? "location.north.line.fill"
                  : locationActive
                    ? "location.fill"
                    : "location"
              }
              size={BLUR_PANEL_ICON_SIZE}
              tintColor="#FFFFFF"
              type="monochrome"
            />
          )}
        </Pressable>
        <Pressable
          accessibilityLabel={globeAccessibilityLabel}
          accessibilityRole="button"
          onPress={() => {
            onMapModeChange?.(MAP_STYLE_AFTER_PRESS[iconIndex]);
            setIconIndex((iconIndex + 1) % MAP_STYLE_AFTER_PRESS.length);
          }}
          style={({ pressed }) => [styles.action, pressed && styles.pressed]}
        >
          {isAndroid ? (
            <FontAwesome6
              color="#FFFFFF"
              name={iconIndex === 1 ? "language" : "globe"}
              size={BLUR_PANEL_ICON_SIZE}
            />
          ) : (
            <SymbolView
              name={iconIndex === 1 ? "globe" : "globe.americas.fill"}
              size={BLUR_PANEL_ICON_SIZE}
              tintColor="#FFFFFF"
              type="monochrome"
            />
          )}
        </Pressable>
        <Animated.View
          pointerEvents={showMapButton ? "auto" : "none"}
          accessibilityElementsHidden={!showMapButton}
          importantForAccessibility={
            showMapButton ? "auto" : "no-hide-descendants"
          }
          style={[
            styles.mapSlot,
            {
              height: reveal.interpolate({
                inputRange: [0, 1],
                outputRange: [0, BLUR_PANEL_ICON_SIZE + BLUR_PANEL_GAP],
              }),
              opacity: reveal,
            },
          ]}
        >
          <Pressable
            accessibilityLabel={
              mapLoading ? "Loading chart information" : "Open map options"
            }
            accessibilityRole="button"
            accessibilityState={{
              busy: mapLoading,
              disabled: mapLoading || !showMapButton,
            }}
            disabled={mapLoading || !showMapButton}
            onPress={mapLoading || !showMapButton ? undefined : onMapPress}
            style={({ pressed }) => [
              styles.action,
              styles.mapAction,
              pressed && styles.pressed,
            ]}
          >
            <LoadingIcon loading={mapLoading}>
              {isAndroid ? (
                <MaterialCommunityIcons
                  color="#FFFFFF"
                  name="map-outline"
                  size={BLUR_PANEL_ICON_SIZE}
                />
              ) : (
                <SymbolView
                  name="map"
                  size={BLUR_PANEL_ICON_SIZE}
                  tintColor="#FFFFFF"
                  type="monochrome"
                />
              )}
            </LoadingIcon>
          </Pressable>
        </Animated.View>
      </View>
    </BlurPanel>
  );
}

const styles = StyleSheet.create({
  controls: {
    alignItems: "center",
    gap: BLUR_PANEL_GAP,
  },
  mapSlot: {
    width: BLUR_PANEL_ICON_SIZE,
    overflow: "hidden",
    // The slot remains mounted at height zero when the map button is hidden.
    // Cancel the stack gap in that state so no empty space is left below the globe.
    marginTop: -BLUR_PANEL_GAP,
  },
  mapAction: {
    paddingTop: BLUR_PANEL_GAP,
    height: BLUR_PANEL_ICON_SIZE + BLUR_PANEL_GAP,
  },
  action: {
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.62,
    transform: [{ scale: 0.92 }],
  },
});
