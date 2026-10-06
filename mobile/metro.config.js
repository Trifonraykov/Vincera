// Metro for the Vincera iPhone app (CLAUDE.md §19.44).
//
// The app shares the mobile API's Zod contract with the server: `@shared/schemas` is
// ../lib/mobile-api/schemas.ts (tsconfig.json maps the alias; Expo's Metro reads tsconfig paths).
// That folder is outside this project, so Metro watches it, and its `zod` import always resolves
// to this app's copy (the repo root's node_modules may be missing, e.g. in the iOS CI job, or hold
// another copy).
const path = require("node:path")

const { getDefaultConfig } = require("expo/metro-config")

const projectRoot = __dirname
const sharedRoot = path.resolve(projectRoot, "../lib/mobile-api")

const config = getDefaultConfig(projectRoot)

config.watchFolders = [...(config.watchFolders ?? []), sharedRoot]

const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "zod" || moduleName.startsWith("zod/")) {
    return context.resolveRequest(
      { ...context, originModulePath: path.join(projectRoot, "package.json") },
      moduleName,
      platform,
    )
  }
  return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
