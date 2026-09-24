import { memo, useMemo } from "react";
import { Platform, StyleSheet, View } from "react-native";
import Svg, {
  Circle,
  G,
  Line,
  Polygon,
  Text as SvgText,
} from "react-native-svg";
import Animated, {
  useAnimatedProps,
  useDerivedValue,
  type SharedValue,
} from "react-native-reanimated";
import { compassRotationMatrix, svgMatrixAdapter } from "./compassTransform";

const COMPASS_SIZE = 240;
const TICK_COUNT = 180;

const CENTER = COMPASS_SIZE / 2;
const LABEL_RADIUS = 76;
const DEGREE_RADIUS = CENTER + 7;
const OUTER_PADDING = 32;
const DEGREE_MARKS = Array.from({ length: 12 }, (_, index) => index * 30);

const AnimatedG = Animated.createAnimatedComponent(G);
const AnimatedSvgText = Animated.createAnimatedComponent(SvgText);

const CompassDegree = memo(function CompassDegree({
  degrees,
  rotation,
}: {
  degrees: number;
  rotation: SharedValue<number>;
}) {
  const radians = degrees * Math.PI / 180;
  const x = CENTER + DEGREE_RADIUS * Math.sin(radians);
  const y = CENTER - DEGREE_RADIUS * Math.cos(radians);
  const animatedProps = useAnimatedProps(() => ({
    transform: compassRotationMatrix(-rotation.value, x, y),
  }), undefined, svgMatrixAdapter);

  return (
    <AnimatedSvgText
      animatedProps={animatedProps}
      x={x}
      y={y}
      fill="#FFFFFF"
      fontFamily={Platform.OS === "ios" ? "System" : "sans-serif"}
      fontSize={12}
      fontWeight="600"
      textAnchor="middle"
      alignmentBaseline="middle"
    >
      {degrees}
    </AnimatedSvgText>
  );
});

type Props = {
  headingValue: SharedValue<number | null>;
};

const CompassTicks = memo(function CompassTicks() {
  const ticks = useMemo(
    () =>
      Array.from({ length: TICK_COUNT }, (_, index) => {
        const angle = (index * 360) / TICK_COUNT;
        const isMajor = index % 15 === 0;

        return (
          <Line
            key={index}
            x1={CENTER}
            y1={14}
            x2={CENTER}
            y2={30}
            stroke="#FFFFFF"
            strokeLinecap="round"
            strokeWidth={isMajor ? 2.5 : 1.5}
            transform={`rotate(${angle} ${CENTER} ${CENTER})`}
          />
        );
      }),
    [],
  );

  return <>{ticks}</>;
});

export function DrawerCompass({ headingValue }: Props) {
  // Apply each sensor sample on the UI runtime, without chasing it with timing.
  const rotation = useDerivedValue(() => -(headingValue.value ?? 0));

  const dialAnimatedProps = useAnimatedProps(() => ({
    transform: compassRotationMatrix(rotation.value, CENTER, CENTER),
  }), undefined, svgMatrixAdapter);

  /*
   * The entire dial rotates, while the labels receive the inverse rotation.
   * They move around the compass while remaining straight and horizontal.
   */

  const northTextAnimatedProps = useAnimatedProps(() => ({
    transform: compassRotationMatrix(-rotation.value, CENTER, CENTER - LABEL_RADIUS + 4),
  }), undefined, svgMatrixAdapter);

  const eastTextAnimatedProps = useAnimatedProps(() => ({
    transform: compassRotationMatrix(-rotation.value, CENTER + LABEL_RADIUS, CENTER),
  }), undefined, svgMatrixAdapter);

  const southTextAnimatedProps = useAnimatedProps(() => ({
    transform: compassRotationMatrix(-rotation.value, CENTER, CENTER + LABEL_RADIUS),
  }), undefined, svgMatrixAdapter);

  const westTextAnimatedProps = useAnimatedProps(() => ({
    transform: compassRotationMatrix(-rotation.value, CENTER - LABEL_RADIUS, CENTER),
  }), undefined, svgMatrixAdapter);

  return (
    <View accessible accessibilityLabel="Compass" style={styles.container}>
      <Svg
        height={COMPASS_SIZE + OUTER_PADDING * 2}
        width={COMPASS_SIZE + OUTER_PADDING * 2}
        viewBox={`${-OUTER_PADDING} ${-OUTER_PADDING} ${COMPASS_SIZE + OUTER_PADDING * 2} ${COMPASS_SIZE + OUTER_PADDING * 2}`}
      >
        {/* Fundo central */}
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={32}
          fill="rgba(142, 142, 147, 0.7)"
        />

        {/* Marcador de heading fixo */}
        <Line
          x1={CENTER}
          y1={30}
          x2={CENTER}
          y2={0}
          stroke="#FFFFFF"
          strokeLinecap="round"
          strokeWidth={3}
        />

        {/* Parte que gira */}
        <AnimatedG animatedProps={dialAnimatedProps}>
          {DEGREE_MARKS.map((degrees) => (
            <CompassDegree key={degrees} degrees={degrees} rotation={rotation} />
          ))}
          {/* Norte */}
          <AnimatedSvgText
            animatedProps={northTextAnimatedProps}
            x={CENTER}
            y={CENTER - LABEL_RADIUS + 4}
            fill="#FFFFFF"
            fontSize={18}
            fontWeight="700"
            textAnchor="middle"
            alignmentBaseline="middle"
          >
            N
          </AnimatedSvgText>

          {/* Leste */}
          <AnimatedSvgText
            animatedProps={eastTextAnimatedProps}
            x={CENTER + LABEL_RADIUS}
            y={CENTER}
            fill="#FFFFFF"
            fontSize={18}
            fontWeight="700"
            textAnchor="middle"
            alignmentBaseline="middle"
          >
            L
          </AnimatedSvgText>

          {/* Sul */}
          <AnimatedSvgText
            animatedProps={southTextAnimatedProps}
            x={CENTER}
            y={CENTER + LABEL_RADIUS}
            fill="#FFFFFF"
            fontSize={18}
            fontWeight="700"
            textAnchor="middle"
            alignmentBaseline="middle"
          >
            S
          </AnimatedSvgText>

          {/* Oeste */}
          <AnimatedSvgText
            animatedProps={westTextAnimatedProps}
            x={CENTER - LABEL_RADIUS}
            y={CENTER}
            fill="#FFFFFF"
            fontSize={18}
            fontWeight="700"
            textAnchor="middle"
            alignmentBaseline="middle"
          >
            O
          </AnimatedSvgText>

          {/* Indicador vermelho do Norte */}
          <Polygon
            points={`${CENTER},0 ${CENTER - 5},8 ${CENTER + 5},8`}
            fill="#FF3B30"
          />

          <CompassTicks />
        </AnimatedG>

        {/* Mira central */}
        <Line
          x1={CENTER - 12}
          y1={CENTER}
          x2={CENTER + 12}
          y2={CENTER}
          stroke="#FFFFFF"
          strokeLinecap="round"
          strokeWidth={1}
        />

        <Line
          x1={CENTER}
          y1={CENTER - 12}
          x2={CENTER}
          y2={CENTER + 12}
          stroke="#FFFFFF"
          strokeLinecap="round"
          strokeWidth={1}
        />

        <Line
          x1={CENTER - 54}
          y1={CENTER}
          x2={CENTER + 54}
          y2={CENTER}
          stroke="#FFFFFF"
          strokeLinecap="round"
          strokeWidth={0.5}
        />

        <Line
          x1={CENTER}
          y1={CENTER - 54}
          x2={CENTER}
          y2={CENTER + 54}
          stroke="#FFFFFF"
          strokeLinecap="round"
          strokeWidth={0.5}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 12,
  },
});
