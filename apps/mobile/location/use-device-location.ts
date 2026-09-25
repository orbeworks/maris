import * as Location from 'expo-location';
import { useEffect, useRef, useState } from 'react';
import { useSharedValue, type SharedValue } from 'react-native-reanimated';

import { resolveHeading, smoothHeading } from './navigation-heading';

const EARTH_RADIUS_METRES = 6_371_000;
const KNOTS_PER_METRE_PER_SECOND = 1.94384;
const GPS_COG_MIN_SPEED_KT = 5;

type TimedCoordinate = {
  coordinate: [number, number];
  timestamp: number;
};

function distanceBetweenPoints(
  first: [number, number],
  second: [number, number],
) {
  const latitude1 = (first[1] * Math.PI) / 180;
  const latitude2 = (second[1] * Math.PI) / 180;
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = ((second[0] - first[0]) * Math.PI) / 180;
  const haversine =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;

  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(haversine));
}

function speedBetweenPoints(
  previous: TimedCoordinate | null,
  current: TimedCoordinate,
) {
  if (!previous || current.timestamp <= previous.timestamp) return null;

  const deltaTimeSeconds = (current.timestamp - previous.timestamp) / 1_000;
  return distanceBetweenPoints(previous.coordinate, current.coordinate) / deltaTimeSeconds;
}

function bearingBetweenPoints(
  previous: TimedCoordinate | null,
  current: TimedCoordinate,
) {
  if (!previous) return null;

  const latitude1 = (previous.coordinate[1] * Math.PI) / 180;
  const latitude2 = (current.coordinate[1] * Math.PI) / 180;
  const deltaLongitude = ((current.coordinate[0] - previous.coordinate[0]) * Math.PI) / 180;
  const y = Math.sin(deltaLongitude) * Math.cos(latitude2);
  const x =
    Math.cos(latitude1) * Math.sin(latitude2) -
    Math.sin(latitude1) * Math.cos(latitude2) * Math.cos(deltaLongitude);

  if (x === 0 && y === 0) return null;

  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function isValidSpeed(speed: number | null | undefined): speed is number {
  return speed != null && Number.isFinite(speed) && speed >= 0;
}

function readCog(
  heading: number | null,
  previousLocation: TimedCoordinate | null,
  currentLocation: TimedCoordinate,
) {
  if (heading !== null && Number.isFinite(heading) && heading >= 0) {
    return ((heading % 360) + 360) % 360;
  }

  return bearingBetweenPoints(previousLocation, currentLocation);
}

export type DeviceLocation = {
  coordinate: [number, number];
  /** Estimated horizontal accuracy in metres, when provided by iOS/Android. */
  accuracy: number | null;
  speed: number | null;
  cog: number | null;
  heading: number | null;
  headingValue: SharedValue<number | null>;
};

export function useDeviceLocation(): DeviceLocation | null {
  const [coordinate, setCoordinate] = useState<[number, number] | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [cog, setCog] = useState<number | null>(null);
  const [heading, setHeading] = useState<number | null>(null);
  const headingValue = useSharedValue<number | null>(null);
  const compassRef = useRef<number | null>(null);
  const smoothedHeadingRef = useRef<number | null>(null);
  const latestLocationRef = useRef<TimedCoordinate | null>(null);
  const latestNativeSpeedAtRef = useRef<number | null>(null);
  const hasInitialHeadingCogRef = useRef(false);
  const hasValidGpsCogRef = useRef(false);

  useEffect(() => {
    let active = true;
    let locationSubscription: Location.LocationSubscription | undefined;
    let headingSubscription: Location.LocationSubscription | undefined;
    let speedFallbackTimer: ReturnType<typeof setInterval> | undefined;
    const publishInitialHeadingCog = (value: number | null) => {
      if (
        value === null ||
        hasInitialHeadingCogRef.current ||
        hasValidGpsCogRef.current
      ) {
        return;
      }
      hasInitialHeadingCogRef.current = true;
      setCog(value);
    };
    const publishSpeed = (location: TimedCoordinate, nativeSpeed: number | null | undefined) => {
      const fallbackSpeed = speedBetweenPoints(latestLocationRef.current, location);
      latestLocationRef.current = location;

      if (isValidSpeed(nativeSpeed)) {
        latestNativeSpeedAtRef.current = location.timestamp;
        setSpeed(nativeSpeed);
        return nativeSpeed;
      } else if (fallbackSpeed !== null) {
        setSpeed(fallbackSpeed);
        return fallbackSpeed;
      }

      return null;
    };

    const publishHeading = () => {
      const nextHeading = compassRef.current;
      const smoothedHeading =
        nextHeading === null
          ? null
          : smoothHeading(smoothedHeadingRef.current, nextHeading);
      smoothedHeadingRef.current = smoothedHeading;
      headingValue.value = smoothedHeading;
      setHeading((currentHeading) =>
        currentHeading === smoothedHeading ? currentHeading : smoothedHeading,
      );
      publishInitialHeadingCog(smoothedHeading);
    };

    const start = async () => {
      const permission = await Location.requestForegroundPermissionsAsync();

      if (!active || permission.status !== Location.PermissionStatus.GRANTED) {
        return;
      }

      const lastKnownPosition = await Location.getLastKnownPositionAsync({
        maxAge: 30_000,
        requiredAccuracy: 100,
      });

      if (active && lastKnownPosition) {
        const lastKnownLocation = {
          coordinate: [
            lastKnownPosition.coords.longitude,
            lastKnownPosition.coords.latitude,
          ] as [number, number],
          timestamp: lastKnownPosition.timestamp,
        };
        setCoordinate([
          lastKnownPosition.coords.longitude,
          lastKnownPosition.coords.latitude,
        ]);
        setAccuracy(lastKnownPosition.coords.accuracy ?? null);
        const initialSpeed = publishSpeed(lastKnownLocation, lastKnownPosition.coords.speed);
        const initialCog =
          initialSpeed !== null &&
          initialSpeed * KNOTS_PER_METRE_PER_SECOND >= GPS_COG_MIN_SPEED_KT
            ? readCog(lastKnownPosition.coords.heading, null, lastKnownLocation)
            : null;
        if (initialCog !== null) {
          hasValidGpsCogRef.current = true;
          setCog(initialCog);
        } else {
          publishInitialHeadingCog(smoothedHeadingRef.current);
        }
      }

      locationSubscription = await Location.watchPositionAsync(
        {
          accuracy: Location.Accuracy.BestForNavigation,
          distanceInterval: 0,
          timeInterval: 1_000,
        },
        (location) => {
          if (!active) return;
          const { coords } = location;
          const currentLocation = {
            coordinate: [coords.longitude, coords.latitude] as [number, number],
            timestamp: location.timestamp,
          };
          setCoordinate([coords.longitude, coords.latitude]);
          setAccuracy(coords.accuracy ?? null);
          const previousLocation = latestLocationRef.current;
          const effectiveSpeed = publishSpeed(currentLocation, coords.speed);
          if (
            effectiveSpeed !== null &&
            effectiveSpeed * KNOTS_PER_METRE_PER_SECOND >= GPS_COG_MIN_SPEED_KT
          ) {
            const nextCog = readCog(
              coords.heading,
              previousLocation,
              currentLocation,
            );
            if (nextCog !== null) {
              hasValidGpsCogRef.current = true;
              setCog(nextCog);
            } else {
              publishInitialHeadingCog(smoothedHeadingRef.current);
            }
          } else {
            publishInitialHeadingCog(smoothedHeadingRef.current);
          }
        },
      );

      speedFallbackTimer = setInterval(() => {
        if (!active) return;
        const latestLocation = latestLocationRef.current;
        if (!latestLocation) return;

        const latestSpeedAt = latestNativeSpeedAtRef.current;
        if (latestSpeedAt !== null && Date.now() - latestSpeedAt < 1_000) return;

        // With no newer native speed, the latest known coordinate is the best
        // available position. A stationary coordinate therefore resolves to 0 m/s.
        const fallbackSpeed = speedBetweenPoints(latestLocation, {
          coordinate: latestLocation.coordinate,
          timestamp: Date.now(),
        }) ?? 0;
        setSpeed(fallbackSpeed);
        publishInitialHeadingCog(smoothedHeadingRef.current);
      }, 1_000);

      headingSubscription = await Location.watchHeadingAsync((value) => {
        if (!active) return;
        const nextHeading = resolveHeading(
          value.trueHeading,
          value.magHeading,
        );

        // Keep the last valid reading visible while the sensor temporarily
        // reports an invalid/low-confidence sample.
        if (nextHeading === null) return;

        compassRef.current = nextHeading;
        publishHeading();
      });
    };

    void start().catch(() => {
      // Location is optional: without permission or a signal, the marker is hidden.
    });

    return () => {
      active = false;
      locationSubscription?.remove();
      headingSubscription?.remove();
      if (speedFallbackTimer) clearInterval(speedFallbackTimer);
    };
  }, [headingValue]);

  if (!coordinate) return null;

  return { coordinate, accuracy, speed, cog, heading, headingValue };
}
