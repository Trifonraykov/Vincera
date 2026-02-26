"use client";

import { motion } from "framer-motion";
import { pageTransition } from "@/lib/animations";

export default function BrainViewPage() {
  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
      className="flex h-full items-center justify-center"
    >
      <h2 className="font-heading text-4xl font-semibold tracking-wide text-text-muted">
        Brain View
      </h2>
    </motion.div>
  );
}
