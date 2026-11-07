// Local alerts only: expo-notifications asks Apple for the Push Notifications capability (aps-environment), which free Apple
// developer accounts cannot have, so the build fails. Remove it. Delete this plugin once the app is signed by a paid account.
const { withEntitlementsPlist } = require('expo/config-plugins')

module.exports = function withoutPush(config) {
  return withEntitlementsPlist(config, c => {
    delete c.modResults['aps-environment']
    return c
  })
}
