"use client";

import { motion } from "framer-motion";
import { breathe, dissolveIn } from "@/lib/animations";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6">
      <motion.h1
        className="font-heading text-6xl font-semibold tracking-[0.3em] text-text-primary uppercase"
        variants={dissolveIn}
        initial="hidden"
        animate="visible"
      >
        Vincera
      </motion.h1>

      <motion.div
        className="h-2 w-2 rounded-full bg-accent"
        variants={breathe}
        animate="animate"
        style={{
          boxShadow: "0 0 8px rgba(0, 255, 136, 0.4), 0 0 20px rgba(0, 255, 136, 0.2)",
        }}
      />

      <motion.p
        className="font-mono text-sm text-text-muted tracking-widest"
        variants={dissolveIn}
        initial="hidden"
        animate="visible"
        transition={{ delay: 0.3 }}
      >
        Neural interface online
      </motion.p>
    </div>
  );
}
