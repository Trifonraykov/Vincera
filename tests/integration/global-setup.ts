import type { TestProject } from "vitest/node"

import {
  dropRunDatabases,
  ensureTemplateDatabase,
  newRunPrefix,
  resolveAdminUrl,
  type TestDatabaseConfig,
} from "../helpers/db-template"

declare module "vitest" {
  export interface ProvidedContext {
    testDatabase: TestDatabaseConfig
  }
}

/**
 * Vitest global setup for the integration project (CLAUDE.md §19.4).
 *
 * Makes sure a migrated template database exists for the current migrations (created once, reused
 * by later runs) and hands its name to the test files, which clone it via tests/helpers/db.ts.
 * Teardown drops any clone a crashed test file left behind.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = resolveAdminUrl()
  const startedAt = Date.now()
  const template = await ensureTemplateDatabase(adminUrl, startedAt)
  const runPrefix = newRunPrefix(startedAt)

  project.provide("testDatabase", { adminUrl, template, runPrefix })

  return async function teardown() {
    await dropRunDatabases(adminUrl, runPrefix)
  }
}
