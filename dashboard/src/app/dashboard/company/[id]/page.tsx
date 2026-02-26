"use client";

import { useParams } from "next/navigation";
import { motion } from "framer-motion";
import { pageTransition } from "@/lib/animations";
import { useDashboard } from "@/contexts/DashboardContext";
import { useCompanyProfile } from "@/hooks/useCompanyProfile";
import CompanyHeader from "@/components/company/CompanyHeader";
import CompanyTabs from "@/components/company/CompanyTabs";

export default function CompanyProfilePage() {
  const params = useParams<{ id: string }>();
  const companyId = params.id;

  const { company } = useDashboard();
  const profile = useCompanyProfile(companyId);

  return (
    <motion.div
      variants={pageTransition}
      initial="hidden"
      animate="visible"
      exit="exit"
    >
      <CompanyHeader
        company={company}
        agentCount={profile.agentStatuses.length}
        automationCount={profile.automations.length}
        totalHoursSaved={profile.totalHoursSaved}
      />

      {profile.isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <span className="font-mono text-sm text-text-muted">Loading...</span>
        </div>
      ) : (
        <CompanyTabs
          companyId={companyId}
          company={company}
          agentStatuses={profile.agentStatuses}
          automations={profile.automations}
          metrics={profile.metrics}
          researchSources={profile.researchSources}
          researchInsights={profile.researchInsights}
          onUpdateAutomationStatus={profile.updateAutomationStatus}
          onDeleteAutomation={profile.deleteAutomation}
          onExportData={profile.exportData}
          onDisconnect={profile.disconnect}
        />
      )}
    </motion.div>
  );
}
