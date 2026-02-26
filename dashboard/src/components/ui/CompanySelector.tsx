"use client";

import { useState, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronUp, Settings } from "lucide-react";
import Link from "next/link";
import { createBrowserClient, isSupabaseConfigured } from "@/lib/supabase";
import type { Company } from "@/lib/supabase";
import { useDashboard } from "@/contexts/DashboardContext";
import { cn } from "@/lib/utils";

interface CompanySelectorProps {
  isExpanded: boolean;
}

function statusDotColor(status: string): string {
  switch (status) {
    case "active":
      return "bg-accent";
    case "paused":
      return "bg-warning";
    case "installing":
    case "ghost":
      return "bg-text-muted";
    default:
      return "bg-error";
  }
}

export default function CompanySelector({ isExpanded }: CompanySelectorProps) {
  const { companyId, setCompanyId, company } = useDashboard();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Fetch companies list
  useEffect(() => {
    if (!isSupabaseConfigured()) return;

    const supabase = createBrowserClient();
    async function fetch() {
      const { data } = await supabase
        .from("companies")
        .select("*")
        .order("name");
      if (data) {
        setCompanies(data as Company[]);
        // Auto-select first company if none selected
        if (!companyId && data.length > 0) {
          setCompanyId(data[0].id);
        }
      }
    }
    fetch();

    // Subscribe to company changes
    const channel = supabase
      .channel("companies-list")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "companies" },
        () => {
          fetch();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [companyId, setCompanyId]);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const initial = company?.name?.charAt(0)?.toUpperCase() ?? "?";

  return (
    <div ref={ref} className="relative">
      {/* Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex w-full items-center gap-3 rounded-md px-3 py-2.5 transition-colors hover:bg-bg-surface",
          isExpanded ? "justify-start" : "justify-center"
        )}
      >
        {/* Avatar circle */}
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-border-primary bg-bg-surface text-xs font-mono text-text-secondary">
          {initial}
        </div>

        {isExpanded && (
          <>
            <div className="flex-1 overflow-hidden text-left">
              <p className="truncate text-sm font-body text-text-primary">
                {company?.name ?? "Select company"}
              </p>
              {company && (
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "inline-block h-1.5 w-1.5 rounded-full",
                      statusDotColor(company.status)
                    )}
                  />
                  <span className="text-xs text-text-muted capitalize">
                    {company.status}
                  </span>
                </div>
              )}
            </div>
            {company && (
              <Link
                href={`/dashboard/company/${company.id}`}
                onClick={(e) => e.stopPropagation()}
                className="rounded p-1 text-text-muted transition-colors hover:text-text-primary"
              >
                <Settings className="h-3.5 w-3.5" />
              </Link>
            )}
            {companies.length > 1 && (
              <ChevronUp
                className={cn(
                  "h-4 w-4 text-text-muted transition-transform",
                  isOpen && "rotate-180"
                )}
              />
            )}
          </>
        )}
      </button>

      {/* Dropdown — opens upward */}
      <AnimatePresence>
        {isOpen && companies.length > 1 && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15 }}
            className={cn(
              "absolute bottom-full left-0 z-50 mb-2 w-56 overflow-hidden rounded-md border border-border-primary bg-bg-surface-raised shadow-lg",
              !isExpanded && "left-1/2 -translate-x-1/2"
            )}
          >
            {companies.map((c) => (
              <button
                key={c.id}
                onClick={() => {
                  setCompanyId(c.id);
                  setIsOpen(false);
                }}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-bg-surface",
                  c.id === companyId && "bg-accent-dim"
                )}
              >
                <span
                  className={cn(
                    "inline-block h-2 w-2 shrink-0 rounded-full",
                    statusDotColor(c.status)
                  )}
                />
                <span className="flex-1 truncate text-sm text-text-primary font-body">
                  {c.name}
                </span>
                {c.id === companyId && (
                  <span className="text-accent text-xs">&#10003;</span>
                )}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
