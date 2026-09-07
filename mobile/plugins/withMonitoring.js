const { withAndroidManifest, withProjectBuildGradle } = require('expo/config-plugins');

module.exports = function withMonitoring(config) {
  config = withAndroidManifest(config, mod => {
    const manifest = mod.modResults.manifest;
    manifest['uses-permission'] ??= [];
    for (const name of ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_DATA_SYNC', 'android.permission.POST_NOTIFICATIONS']) {
      if (!manifest['uses-permission'].some(p => p.$['android:name'] === name)) manifest['uses-permission'].push({ $: { 'android:name': name } });
    }
    const app = manifest.application[0];
    // A LAN fallback is an explicit user-configured local HTTP endpoint.
    app.$['android:usesCleartextTraffic'] = 'true';
    app.service ??= [];
    const name = 'app.notifee.core.ForegroundService';
    const service = app.service.find(s => s.$['android:name'] === name);
    if (service) service.$['android:foregroundServiceType'] = 'dataSync';
    else app.service.push({ $: { 'android:name': name, 'android:exported': 'false', 'android:foregroundServiceType': 'dataSync' } });
    return mod;
  });
  // Notifee's core AAR is distributed in the package's local Maven repository.
  return withProjectBuildGradle(config, mod => {
    const marker = "maven { url \"$rootDir/../node_modules/@notifee/react-native/android/libs\" }";
    if (!mod.modResults.contents.includes(marker)) {
      mod.modResults.contents += `\nallprojects { repositories { ${marker} } }\n`;
    }
    return mod;
  });
};
