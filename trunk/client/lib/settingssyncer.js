// Copyright 2005 and onwards, Google
//
// Implements GISyncComponent for Clobber's internal settings. Currently, this
// is just two preferences - the list of synchronized and encrypted components.


/**
 * Factory function for getting an instance of CLB_PreferencesSyncer set up to
 * sync Clobber's internal settings. 
 */
function CLB_SettingsSyncer() {
  return new CLB_PreferencesSyncer(
    CLB_SettingsSyncer.CONTRACT_ID,
    "Google Browser Sync Settings",
    "CLB_PreferencesSyncer",
    CLB_SettingsSyncer.PREF_NAMES_);
}

CLB_SettingsSyncer.CONTRACT_ID = "@google.com/browserstate/settings-syncer;1";

CLB_SettingsSyncer.PREF_NAMES_ = [
  "extensions.browserstate.syncedComponents",
  "extensions.browserstate.encryptedComponents",
  "extensions.browserstate.reimportComponent.",
  "extensions.browserstate.v3migrated"
  ];
