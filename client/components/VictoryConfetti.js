import React, { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Animated, useWindowDimensions, Easing } from 'react-native';

const COLORS = [
  '#FFD700', '#FF6B35', '#E63946', '#2EC4B6', '#4361EE',
  '#F72585', '#4CC9F0', '#06D6A0', '#FFB703', '#FB5607',
];

const PARTICLE_COUNT = 110;

function buildParticles(width, height) {
  const cx = width * 0.5;
  const cy = height * 0.42;
  return Array.from({ length: PARTICLE_COUNT }, (_, i) => {
    const angle = Math.random() * Math.PI * 2;
    const speed = 140 + Math.random() * 320;
    const isRect = Math.random() > 0.35;
    return {
      id: i,
      originX: cx + (Math.random() - 0.5) * 40,
      originY: cy + (Math.random() - 0.5) * 30,
      burstX: Math.cos(angle) * speed,
      burstY: Math.sin(angle) * speed - (80 + Math.random() * 120),
      fallY: 180 + Math.random() * 260,
      driftX: (Math.random() - 0.5) * 90,
      color: COLORS[i % COLORS.length],
      w: isRect ? 7 + Math.random() * 9 : 5 + Math.random() * 5,
      h: isRect ? 4 + Math.random() * 6 : 5 + Math.random() * 5,
      spin: (Math.random() > 0.5 ? 1 : -1) * (360 + Math.random() * 720),
      delay: Math.random() * 180,
      duration: 1700 + Math.random() * 900,
    };
  });
}

export default function VictoryConfetti({ onDone }) {
  const { width, height } = useWindowDimensions();
  const particles = useMemo(() => buildParticles(width, height), [width, height]);
  const anims = useRef(
    particles.map(() => ({
      progress: new Animated.Value(0),
      opacity: new Animated.Value(0),
    }))
  ).current;

  useEffect(() => {
    const runs = particles.map((p, i) => {
      return Animated.sequence([
        Animated.delay(p.delay),
        Animated.parallel([
          Animated.timing(anims[i].opacity, {
            toValue: 1,
            duration: 80,
            useNativeDriver: true,
          }),
          Animated.timing(anims[i].progress, {
            toValue: 1,
            duration: p.duration,
            easing: Easing.out(Easing.cubic),
            useNativeDriver: true,
          }),
        ]),
        Animated.timing(anims[i].opacity, {
          toValue: 0,
          duration: 420,
          useNativeDriver: true,
        }),
      ]);
    });

    Animated.parallel(runs).start(({ finished }) => {
      if (finished && onDone) onDone();
    });
  }, [particles, anims, onDone]);

  return (
    <View style={styles.layer} pointerEvents="none">
      {particles.map((p, i) => {
        const translateX = anims[i].progress.interpolate({
          inputRange: [0, 1],
          outputRange: [0, p.burstX + p.driftX],
        });
        const translateY = anims[i].progress.interpolate({
          inputRange: [0, 0.45, 1],
          outputRange: [0, p.burstY, p.burstY + p.fallY],
        });
        const rotate = anims[i].progress.interpolate({
          inputRange: [0, 1],
          outputRange: ['0deg', `${p.spin}deg`],
        });
        const scale = anims[i].progress.interpolate({
          inputRange: [0, 0.2, 1],
          outputRange: [0.2, 1.1, 0.85],
        });

        return (
          <Animated.View
            key={p.id}
            style={[
              styles.piece,
              {
                left: p.originX,
                top: p.originY,
                width: p.w,
                height: p.h,
                backgroundColor: p.color,
                opacity: anims[i].opacity,
                transform: [
                  { translateX },
                  { translateY },
                  { rotate },
                  { scale },
                ],
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  layer: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 9999,
    overflow: 'hidden',
  },
  piece: {
    position: 'absolute',
    borderRadius: 2,
  },
});