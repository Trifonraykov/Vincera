// Overrides for local release builds (scripts/testflight.sh): your own bundle id and Apple team.
// Everything else comes from app.json.
module.exports = ({ config }) => ({
  ...config,
  ios: {
    ...config.ios,
    ...(process.env.VINCERA_BUNDLE_ID ? { bundleIdentifier: process.env.VINCERA_BUNDLE_ID } : {}),
    ...(process.env.APPLE_TEAM_ID ? { appleTeamId: process.env.APPLE_TEAM_ID } : {}),
  },
})
