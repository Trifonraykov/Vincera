"use client";

import {
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
  useCallback,
} from "react";
import { useReducedMotion } from "framer-motion";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ParticleCanvasHandle {
  pause: () => void;
  resume: () => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  opacity: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PARTICLE_COUNT = 35;
const PARTICLE_RADIUS = 1;
const MIN_OPACITY = 0.12;
const MAX_OPACITY = 0.18;
const DRIFT_SPEED = 0.08;
const CONNECTION_DIST_SQ = 120 * 120; // squared to skip sqrt
const CONNECTION_DIST = 120;
const CONNECTION_MAX_OPACITY = 0.05;
const LINE_WIDTH = 0.5;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const ParticleCanvas = forwardRef<ParticleCanvasHandle>(
  function ParticleCanvas(_props, ref) {
    const shouldReduce = useReducedMotion();
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const particlesRef = useRef<Particle[]>([]);
    const rafRef = useRef<number>(0);
    const isPausedRef = useRef(false);
    const isTabVisibleRef = useRef(true);
    const sizeRef = useRef({ w: 0, h: 0 });

    // Expose pause/resume to parent (dashboard layout → PauseOverlay)
    useImperativeHandle(ref, () => ({
      pause: () => {
        isPausedRef.current = true;
      },
      resume: () => {
        isPausedRef.current = false;
      },
    }));

    // Initialize particles at random positions
    const initParticles = useCallback((w: number, h: number) => {
      const particles: Particle[] = [];
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        particles.push({
          x: Math.random() * w,
          y: Math.random() * h,
          vx: (Math.random() - 0.5) * DRIFT_SPEED * 2,
          vy: (Math.random() - 0.5) * DRIFT_SPEED * 2,
          opacity: MIN_OPACITY + Math.random() * (MAX_OPACITY - MIN_OPACITY),
        });
      }
      particlesRef.current = particles;
    }, []);

    // Animation loop — runs outside React render cycle
    const tick = useCallback(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const { w, h } = sizeRef.current;
      ctx.clearRect(0, 0, w, h);

      const particles = particlesRef.current;

      // Move particles (skip when paused or tab hidden — keeps canvas static)
      if (!isPausedRef.current && isTabVisibleRef.current) {
        for (let i = 0; i < particles.length; i++) {
          const p = particles[i];
          p.x += p.vx;
          p.y += p.vy;

          // Toroidal wrapping
          if (p.x < 0) p.x += w;
          else if (p.x > w) p.x -= w;
          if (p.y < 0) p.y += h;
          else if (p.y > h) p.y -= h;
        }
      }

      // Draw connection lines (compare squared distance to avoid sqrt)
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x;
          const dy = particles[i].y - particles[j].y;
          const distSq = dx * dx + dy * dy;
          if (distSq < CONNECTION_DIST_SQ) {
            const dist = Math.sqrt(distSq);
            const lineOpacity =
              CONNECTION_MAX_OPACITY * (1 - dist / CONNECTION_DIST);
            ctx.beginPath();
            ctx.moveTo(particles[i].x, particles[i].y);
            ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(255,255,255,${lineOpacity})`;
            ctx.lineWidth = LINE_WIDTH;
            ctx.stroke();
          }
        }
      }

      // Draw particles
      for (let i = 0; i < particles.length; i++) {
        const p = particles[i];
        ctx.beginPath();
        ctx.arc(p.x, p.y, PARTICLE_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255,255,255,${p.opacity})`;
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(tick);
    }, []);

    useEffect(() => {
      if (shouldReduce) return;

      const canvas = canvasRef.current;
      if (!canvas) return;

      // Size canvas to viewport
      function handleResize() {
        if (!canvas) return;
        const dpr = window.devicePixelRatio || 1;
        const w = window.innerWidth;
        const h = window.innerHeight;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.scale(dpr, dpr);
        sizeRef.current = { w, h };

        if (particlesRef.current.length === 0) {
          initParticles(w, h);
        }
      }

      // Tab visibility — pause loop when hidden
      function handleVisibility() {
        isTabVisibleRef.current = !document.hidden;
      }

      handleResize();
      window.addEventListener("resize", handleResize);
      document.addEventListener("visibilitychange", handleVisibility);

      // Start animation loop
      rafRef.current = requestAnimationFrame(tick);

      return () => {
        cancelAnimationFrame(rafRef.current);
        window.removeEventListener("resize", handleResize);
        document.removeEventListener("visibilitychange", handleVisibility);
      };
    }, [shouldReduce, initParticles, tick]);

    // Reduced motion — don't render canvas at all
    if (shouldReduce) return null;

    return (
      <canvas
        ref={canvasRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-0"
        style={{ zIndex: 1 }}
      />
    );
  }
);

export default ParticleCanvas;
