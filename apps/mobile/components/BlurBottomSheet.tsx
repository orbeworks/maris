import { BlurView } from "expo-blur";
import { PropsWithChildren, useCallback, useEffect, useRef } from "react";
import {
  Animated,
  PanResponder,
  StyleSheet,
  View,
} from "react-native";

const SHEET_ANIMATION_DURATION = 260;
const DISMISS_DISTANCE = 96;

type BlurBottomSheetProps = PropsWithChildren<{
  visible: boolean;
  onClose: () => void;
  closeSignal?: number;
}>;

export function BlurBottomSheet({
  children,
  visible,
  onClose,
  closeSignal = 0,
}: BlurBottomSheetProps) {
  const translateY = useRef(new Animated.Value(0)).current;
  const isDismissing = useRef(false);
  const lastCloseSignal = useRef(closeSignal);
  const closeWithAnimation = useCallback(() => {
    if (isDismissing.current) return;
    isDismissing.current = true;
    Animated.timing(translateY, {
      toValue: 800,
      duration: SHEET_ANIMATION_DURATION,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) onClose();
    });
  }, [onClose, translateY]);
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gestureState) =>
        gestureState.dy > 5 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx),
      onPanResponderMove: (_, gestureState) => {
        translateY.setValue(Math.max(0, gestureState.dy));
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy > DISMISS_DISTANCE || gestureState.vy > 0.8) {
          isDismissing.current = true;
          Animated.timing(translateY, {
            toValue: 800,
            duration: SHEET_ANIMATION_DURATION,
            useNativeDriver: true,
          }).start(({ finished }) => {
            if (finished) onClose();
          });
          return;
        }
        Animated.spring(translateY, {
          toValue: 0,
          useNativeDriver: true,
          damping: 24,
          stiffness: 280,
          mass: 0.8,
        }).start();
      },
    }),
  ).current;

  useEffect(() => {
    if (!visible) return;
    isDismissing.current = false;
    translateY.setValue(800);
    Animated.timing(translateY, {
      toValue: 0,
      duration: SHEET_ANIMATION_DURATION,
      useNativeDriver: true,
    }).start();
  }, [translateY, visible]);

  useEffect(() => {
    if (closeSignal === lastCloseSignal.current) return;
    lastCloseSignal.current = closeSignal;
    if (visible) closeWithAnimation();
  }, [closeSignal, closeWithAnimation, visible]);

  if (!visible) return null;

  return (
    <View style={styles.overlay} pointerEvents="box-none">
        <Animated.View
          {...panResponder.panHandlers}
          style={[styles.sheet, { transform: [{ translateY }] }]}
        >
          <BlurView
            intensity={6}
            tint="systemMaterialDark"
            style={StyleSheet.absoluteFill}
          />
          <View accessible accessibilityLabel="Drag down to close" style={styles.handle} />
          <View style={styles.content}>{children}</View>
        </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    justifyContent: "flex-end",
  },
  sheet: {
    alignSelf: "center",
    width: "97%",
    minHeight: 120,
    maxHeight: "88%",
    overflow: "hidden",
    borderRadius: 36,
    paddingTop: 3,
    paddingBottom: 24,
    marginBottom: 0,
    backgroundColor: "rgba(20, 32, 40, 0.24)",
    borderWidth: 0.8,
    borderColor: "rgba(255, 255, 255, 0.32)",
  },
  handle: {
    alignSelf: "center",
    width: 60,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255, 255, 255, 0.55)",
    marginBottom: 10,
  },
  content: {
    paddingHorizontal: 24,
  },
});
