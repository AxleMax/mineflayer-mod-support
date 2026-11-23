'use strict'

// Explicit data for Farmer's Delight 1.20.1-1.2.11, not an automatic claim.
// ModItems: tomato uses default Item.Properties (64); rotten tomato calls
// stacksTo(16). CookingPotMenu: input 0..5, meal/container/result 6..8,
// followed by player inventory and hotbar. See verification source evidence.
module.exports = {
  id: 'farmersdelight-data', apiVersion: 1,
  loaderProtocols: ['forge'], minecraftVersions: ['1.20.1'],
  setup (context) {
    context.defineItem('farmersdelight:tomato', { stackSize: 64 })
    context.defineItem('farmersdelight:rotten_tomato', { stackSize: 16 })
    context.defineMenu('farmersdelight:cooking_pot', { containerSlots: 9, playerInventory: 'appended-36', craftingResultSlot: 8, standardClick: true })
  }
}
