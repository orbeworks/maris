const { withInfoPlist, withXcodeProject } = require("expo/config-plugins");

const PRODUCTION_BUNDLE_ID = "com.orbeworks.maris";
const DEVELOPMENT_BUNDLE_ID = "com.orbeworks.maris.dev";
const APPLE_TEAM_ID = "J728Z86KY5";

/**
 * Keeps local Debug builds separate from TestFlight/App Store builds.
 * The generated iOS directory is ignored, so this plugin makes the split
 * reproducible whenever Expo regenerates the native project.
 */
function withIosAppVariants(config) {
  config = withInfoPlist(config, (modConfig) => {
    modConfig.modResults.CFBundleDisplayName = "$(MARIS_DISPLAY_NAME)";

    for (const urlType of modConfig.modResults.CFBundleURLTypes ?? []) {
      if (Array.isArray(urlType.CFBundleURLSchemes)) {
        urlType.CFBundleURLSchemes = urlType.CFBundleURLSchemes.map(
          () => "$(PRODUCT_BUNDLE_IDENTIFIER)",
        );
      }
    }

    return modConfig;
  });

  return withXcodeProject(config, (modConfig) => {
    const configurations = modConfig.modResults.pbxXCBuildConfigurationSection();

    for (const [key, configuration] of Object.entries(configurations)) {
      if (key.endsWith("_comment") || !configuration.buildSettings) continue;
      if (!("PRODUCT_BUNDLE_IDENTIFIER" in configuration.buildSettings)) continue;

      const isDebug = configuration.name === "Debug";
      configuration.buildSettings.PRODUCT_BUNDLE_IDENTIFIER = isDebug
        ? DEVELOPMENT_BUNDLE_ID
        : PRODUCTION_BUNDLE_ID;
      configuration.buildSettings.CODE_SIGN_STYLE = "Automatic";
      configuration.buildSettings.DEVELOPMENT_TEAM = APPLE_TEAM_ID;
      configuration.buildSettings.MARIS_DISPLAY_NAME = isDebug
        ? '"Maris Dev"'
        : "Maris";
    }

    return modConfig;
  });
}

module.exports = withIosAppVariants;
