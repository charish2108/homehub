const { withAndroidManifest } = require('expo/config-plugins');

module.exports = function withLocalHubHttp(config) {
  return withAndroidManifest(config, (modConfig) => {
    const application = modConfig.modResults.manifest.application?.[0];
    if (!application) {
      throw new Error('Unable to configure Android cleartext access: application manifest entry is missing');
    }

    application.$ ??= {};
    application.$['android:usesCleartextTraffic'] = 'true';
    return modConfig;
  });
};
