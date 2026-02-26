"use client";

import { useState, useEffect, useRef } from "react";
import type { Variants } from "framer-motion";

// ---------------------------------------------------------------------------
// Page-level transitions
// ---------------------------------------------------------------------------

export const pageTransition: Variants = {
  hidden: { opacity: 0, y: 10 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: [0.25, 0.1, 0.25, 1] },
  },
  exit: {
    opacity: 0,
    y: -10,
    transition: { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] },
  },
};

// ---------------------------------------------------------------------------
// Card / element entrances
// ---------------------------------------------------------------------------

export const cardEntrance: Variants = {
  hidden: { opacity: 0, scale: 0.95 },
  visible: {
    opacity: 1,
    scale: 1,
    transition: { duration: 0.35, ease: [0.33, 1, 0.68, 1] },
  },
};

export const slideInRight: Variants = {
  hidden: { opacity: 0, x: 20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.4, ease: [0.33, 1, 0.68, 1] },
  },
};

export const dissolveIn: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 0.5, ease: "easeOut" },
  },
};

// ---------------------------------------------------------------------------
// Live / status animations
// ---------------------------------------------------------------------------

export const pulseGlow: Variants = {
  animate: {
    boxShadow: [
      "0 0 4px rgba(0, 255, 136, 0.2)",
      "0 0 16px rgba(0, 255, 136, 0.6)",
      "0 0 4px rgba(0, 255, 136, 0.2)",
    ],
    transition: { duration: 2, ease: "easeInOut", repeat: Infinity },
  },
};

export const breathe: Variants = {
  animate: {
    scale: [1, 1.02, 1],
    transition: { duration: 4, ease: "easeInOut", repeat: Infinity },
  },
};

// ---------------------------------------------------------------------------
// Interactive
// ---------------------------------------------------------------------------

export const ripple: Variants = {
  initial: { scale: 0, opacity: 0.6 },
  animate: {
    scale: 2.5,
    opacity: 0,
    transition: { duration: 0.6, ease: [0.33, 1, 0.68, 1] },
  },
};

export const chatMessageIn: Variants = {
  hidden: { opacity: 0, y: 15 },
  visible: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      ease: [0.25, 0.1, 0.25, 1],
      y: { type: "spring", stiffness: 300, damping: 24 },
    },
  },
};

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Animates from 0 to `target` over `duration` seconds.
 * Returns the current animated value.
 */
export function useNumberCountUp(target: number, duration = 1.5): number {
  const [current, setCurrent] = useState(0);
  const startTimeRef = useRef<number | null>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (target === 0) {
      setCurrent(0);
      return;
    }

    startTimeRef.current = null;

    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) {
        startTimeRef.current = timestamp;
      }

      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / (duration * 1000), 1);
      // Ease-out cubic
      const eased = 1 - Math.pow(1 - progress, 3);

      setCurrent(Math.round(eased * target));

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      }
    };

    rafRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return current;
}

// ---------------------------------------------------------------------------
// Stagger helper
// ---------------------------------------------------------------------------

/**
 * Returns a parent variant object with staggerChildren for orchestrating
 * child animation timing.
 */
export function staggerChildren(staggerDelay = 0.08): Variants {
  return {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: staggerDelay,
      },
    },
  };
}
