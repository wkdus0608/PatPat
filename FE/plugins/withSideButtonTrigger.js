/**
 * Side-button recording trigger.
 *
 * iPhone: adds an App Intent ("PatPat 녹음 시작") + App Shortcut phrases to the app target so Siri
 *   (press and hold the side button) and the Shortcuts app (Action Button, Back Tap) can start recording.
 * Galaxy: adds a static app shortcut ("녹음 시작") that opens patpat://record/start. One UI's
 *   Side button > Double press > Apps can launch the app or, on versions that list them, this shortcut.
 *
 * Neither platform lets an app read the physical side/power button directly, so both routes use the
 * operating system's own side-button setting. See plans/FE-05-side-button-trigger.md.
 */
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig, IOSConfig, withAndroidManifest, withDangerousMod, withInfoPlist, withStringsXml, withXcodeProject,
} = require('expo/config-plugins');

const SWIFT_FILE = 'StartRecordingIntent.swift';
const SHORTCUTS_XML = 'patpat_shortcuts';
const START_URL = 'patpat://record/start';

function withIosIntent(config) {
  config = withDangerousMod(config, ['ios', (cfg) => {
    const source = path.join(cfg.modRequest.projectRoot, 'plugins', 'native', SWIFT_FILE);
    const target = path.join(cfg.modRequest.platformProjectRoot, cfg.modRequest.projectName, SWIFT_FILE);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    return cfg;
  }]);
  config = withXcodeProject(config, (cfg) => {
    const projectName = cfg.modRequest.projectName;
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: path.join(projectName, SWIFT_FILE),
      groupName: projectName,
      project: cfg.modResults,
    });
    // The helper writes `explicitFileType = undefined`, which would override the Swift file type. Remove it.
    const references = cfg.modResults.pbxFileReferenceSection();
    for (const key of Object.keys(references)) {
      const reference = references[key];
      if (reference && typeof reference === 'object' && String(reference.path).includes(SWIFT_FILE)) {
        delete reference.explicitFileType;
        delete reference.includeInIndex;
      }
    }
    return cfg;
  });
  // Spoken names Siri may hear instead of "PatPat" (the product name in the UI is 쓰담쓰담).
  return withInfoPlist(config, (cfg) => {
    cfg.modResults.INAlternativeAppNames = [
      { INAlternativeAppName: '쓰담쓰담' },
      { INAlternativeAppName: '팻팻' },
      { INAlternativeAppName: '패트팻' },
    ];
    return cfg;
  });
}

function withAndroidShortcut(config) {
  config = withStringsXml(config, (cfg) => {
    cfg.modResults = AndroidConfig.Strings.setStringItem([
      { $: { name: 'patpat_shortcut_record_short', translatable: 'false' }, _: '녹음 시작' },
      { $: { name: 'patpat_shortcut_record_long', translatable: 'false' }, _: 'PatPat 관찰 녹음 시작' },
    ], cfg.modResults);
    return cfg;
  });
  config = withDangerousMod(config, ['android', (cfg) => {
    const packageName = cfg.android && cfg.android.package;
    if (!packageName) throw new Error('android.package is required for the side-button shortcut');
    const directory = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${SHORTCUTS_XML}.xml`), `<?xml version="1.0" encoding="utf-8"?>
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
    android:shortcutId="patpat_start_recording"
    android:enabled="true"
    android:icon="@mipmap/ic_launcher"
    android:shortcutShortLabel="@string/patpat_shortcut_record_short"
    android:shortcutLongLabel="@string/patpat_shortcut_record_long">
    <intent
      android:action="android.intent.action.VIEW"
      android:targetPackage="${packageName}"
      android:targetClass="${packageName}.MainActivity"
      android:data="${START_URL}" />
  </shortcut>
</shortcuts>
`);
    return cfg;
  }]);
  return withAndroidManifest(config, (cfg) => {
    const activity = AndroidConfig.Manifest.getMainActivityOrThrow(cfg.modResults);
    const metaData = activity['meta-data'] || (activity['meta-data'] = []);
    if (!metaData.some((item) => item.$['android:name'] === 'android.app.shortcuts')) {
      metaData.push({ $: { 'android:name': 'android.app.shortcuts', 'android:resource': `@xml/${SHORTCUTS_XML}` } });
    }
    return cfg;
  });
}

module.exports = function withSideButtonTrigger(config) {
  return withAndroidShortcut(withIosIntent(config));
};
