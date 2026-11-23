'use strict'
// Explicit, versioned protocol adapter. GuardSetPatrolPosPacket's encode/decode
// are int entityId + boolean pressed. Registration index 2, channel version 1.
// Reviewed against Guard Villagers Forge 1.20.1-1.6.19; no Java Mod identity claim.
module.exports={
  id:'guardvillagers-patrol',apiVersion:1,loaderProtocols:['forge'],minecraftVersions:['1.20.1'],
  matches:{mods:{guardvillagers:'1.20.1-1.6.19'},channels:{'guardvillagers:main':'1'},registries:{'minecraft:entity_type':['guardvillagers:guard']}},
  setup(ctx){ctx.registerChannel({id:'guardvillagers:main',version:'1',messages:[{
    name:'setPatrolPosition',discriminator:2,direction:'serverbound',schema:{type:'struct',fields:[{name:'entityId',codec:{type:'int'}},{name:'pressed',codec:{type:'boolean'}}]}
  }]})}
}
