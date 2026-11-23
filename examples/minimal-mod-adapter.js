'use strict'

// Copy this into your own adapter package, replace identifiers/versions and
// supply metadata verified from the target Mod. No ID or channel is invented.
module.exports = {
  id: 'example-content',
  apiVersion: 1,
  loaderProtocols: ['forge'],
  minecraftVersions: ['1.20.1'],
  setup (context) {
    context.defineItem('example:component', { displayName: 'Component', stackSize: 64 })
    // Only declare this when the actual menu has 9 container slots followed
    // by the player's 36 slots and supports standard vanilla click semantics.
    context.defineMenu('example:machine', { containerSlots: 9, playerInventory: 'appended-36', standardClick: true })
    context.onChannel('example:updates', event => {
      // An observation is not a decoded message or implemented Mod behavior.
      // Register a verified decoder/network profile for actual custom packets.
      void event
    })
  }
}
