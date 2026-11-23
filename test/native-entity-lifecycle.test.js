'use strict'
const test=require('node:test'), assert=require('node:assert/strict'), {EventEmitter}=require('node:events')
const {ServerRegistryMappings}=require('../src/runtime/registry-mappings')
const {NativeRegistryBridge}=require('../src/runtime/native-registry-bridge')
function install(mappings, ids) { mappings.install({registryName:'minecraft:entity_type',hasSnapshot:true,entriesDecoded:true,snapshot:{ids,aliases:[],overrides:[],blocked:[]}}) }
function makeBot(base) {
  const bot=new EventEmitter();bot.registry=base;bot.version='1.20.1';bot._client=new EventEmitter();bot._client.write=()=>{}
  bot.supportFeature=base.supportFeature.bind(base);bot.username='EntityTest';return bot
}
test('real Mineflayer entity plugin uses Forge identities through spawn/move/metadata/destroy',()=>{
  const base=require('prismarine-registry')('1.20.1');const id=base.entitiesByName.pig.id
  const mappings=new ServerRegistryMappings();const bot=makeBot(base)
  const bridge=new NativeRegistryBridge({mappings}).attachBot(bot)
  // Initialize real upstream plugin before the Forge snapshot arrives.
  require('mineflayer/lib/plugins/entities')(bot,{})
  install(mappings,[{id,name:'holdout:drone'},{id:600,name:'minecraft:pig'}]);bridge.syncRegistry('minecraft:entity_type')
  const events=[];for(const event of ['entitySpawn','entityMoved','entityUpdate','entityGone'])bot.on(event,e=>events.push({event,id:e.id,name:e.name,pos:e.position.clone()}))
  const spawn=(entityId,type)=>bot._client.emit('spawn_entity',{entityId,type,objectUUID:'00112233-4455-6677-8899-aabbccddeeff',x:1,y:65,z:3,yaw:0,pitch:0})
  spawn(900,id);const entity=bot.entities[900]
  assert.equal(entity.name,'holdout:drone');assert.equal(entity.entityType,id);assert.equal(entity.modSupportRegistryType.name,'holdout:drone')
  assert.equal(entity.height,undefined);assert.equal(entity.width,undefined)
  assert.equal(entity.modSupportRegistryType.metadataComplete,false)
  bot._client.emit('rel_entity_move',{entityId:900,dX:4096,dY:0,dZ:0})
  assert.equal(entity.position.x,2)
  bot._client.emit('entity_metadata',{entityId:900,metadata:[{key:0,type:'byte',value:0}]})
  assert.equal(entity.metadata[0],0)
  spawn(901,600);assert.equal(bot.entities[901].name,'pig');assert.equal(bot.entities[901].height,base.entitiesByName.pig.height)
  bot._client.emit('entity_destroy',{entityIds:[900]})
  assert.equal(bot.entities[900],undefined);assert.equal(entity.isValid,false)
  assert.deepEqual(events.filter(e=>e.id===900).map(e=>e.event),['entitySpawn','entityMoved','entityUpdate','entityGone'])
  assert.equal(base.entities[id].name,'pig');assert.equal(base.entities[600],undefined)
  bridge.destroy();assert.equal(bot.registry,base)
})
test('entity overlay is isolated per bot and replacement removes stale IDs',()=>{
  const base=require('prismarine-registry')('1.20.1'),a=new ServerRegistryMappings(),b=new ServerRegistryMappings()
  const ba=makeBot(base),bb=makeBot(base),pa=new NativeRegistryBridge({mappings:a}).attachBot(ba),pb=new NativeRegistryBridge({mappings:b}).attachBot(bb)
  install(a,[{id:400,name:'a:one'}]);install(b,[{id:400,name:'b:two'}]);pa.syncRegistry('minecraft:entity_type');pb.syncRegistry('minecraft:entity_type')
  assert.equal(ba.registry.entities[400].name,'a:one');assert.equal(bb.registry.entities[400].name,'b:two')
  install(a,[{id:401,name:'a:new'}]);pa.syncRegistry('minecraft:entity_type');assert.equal(ba.registry.entities[400],undefined)
  assert.equal(bb.registry.entities[400].name,'b:two');pa.destroy();pb.destroy()
})
const {ForgeEntityBridge,decodeForgeSpawn}=require('../src/protocol/forge/entity-spawn')
function spawnBytes(type,id,additional=Buffer.alloc(0)) {
  const {WireWriter}=require('../src/protocol/forge/wire');const prefix=new WireWriter().varInt(type).finish()
  const rest=Buffer.alloc(4+16+24+3+6);let p=0;rest.writeInt32BE(id,p);p+=4
  Buffer.from('00112233445566778899aabbccddeeff','hex').copy(rest,p);p+=16
  for(const n of [1,65,3]){rest.writeDoubleBE(n,p);p+=8}
  rest.writeInt8(-32,p++);rest.writeInt8(64,p++);rest.writeInt8(12,p++)
  for(const n of [800,-800,0]){rest.writeInt16BE(n,p);p+=2}
  return Buffer.concat([prefix,rest,new WireWriter().varInt(additional.length).finish(),additional])
}
test('Forge standard spawn feeds the real Mineflayer entity lifecycle and preserves bounded extra data',()=>{
  const base=require('prismarine-registry')('1.20.1'),mappings=new ServerRegistryMappings(),bot=makeBot(base)
  const nativeRegistry=new NativeRegistryBridge({mappings}).attachBot(bot);require('mineflayer/lib/plugins/entities')(bot,{})
  install(mappings,[{id:122,name:'blind:projectile'}]);nativeRegistry.syncRegistry('minecraft:entity_type')
  bot._client.version='1.20.1';const runtime=new EventEmitter();Object.assign(runtime,{bot,client:bot._client,nativeRegistry})
  const bridge=new ForgeEntityBridge(runtime),body=spawnBytes(122,991,Buffer.from([7,8]))
  const r=bridge.observe({channel:'fml:play',direction:'inbound',phase:'play',data:Buffer.concat([Buffer.from([0]),body])})
  assert.equal(r.status,'handled');const entity=bot.entities[991]
  assert.equal(entity.name,'blind:projectile');assert.equal(entity.uuid,'00112233-4455-6677-8899-aabbccddeeff')
  assert.equal(entity.position.y,65);assert.deepEqual([...entity.modSupportSpawnData],[7,8]);entity.modSupportSpawnData[0]=99
  assert.equal(entity.modSupportSpawnData[0],7);assert.equal(bridge.getReport().additionalDataSemanticsImplemented,false)
  bot._client.emit('entity_destroy',{entityIds:[991]});assert.equal(bot.entities[991],undefined)
  nativeRegistry.destroy()
})
test('Forge spawn rejects truncated or trailing extension bytes before creating any entity',()=>{
  const body=spawnBytes(122,991,Buffer.from([7,8]));assert.equal(decodeForgeSpawn(body).additionalData.length,2)
  assert.throws(()=>decodeForgeSpawn(body.subarray(0,-1)))
  assert.throws(()=>decodeForgeSpawn(Buffer.concat([body,Buffer.from([0])])))
})
test('entity dropped stacks and equipment use per-bot item IDs and preserve count/NBT',()=>{
  const base=require('prismarine-registry')('1.20.1'),mappings=new ServerRegistryMappings(),bot=makeBot(base)
  const bridge=new NativeRegistryBridge({mappings}).attachBot(bot);require('mineflayer/lib/plugins/entities')(bot,{})
  const itemId=base.itemsByName.stone.id
  mappings.install({registryName:'minecraft:item',hasSnapshot:true,entriesDecoded:true,snapshot:{ids:[{id:itemId,name:'blind:gem'}],aliases:[],overrides:[],blocked:[]}});bridge.syncRegistry('minecraft:item')
  const type=base.entitiesByName.item.id;install(mappings,[{id:type,name:'minecraft:item'}]);bridge.syncRegistry('minecraft:entity_type')
  bot._client.emit('spawn_entity',{entityId:777,type,objectUUID:'00112233-4455-6677-8899-aabbccddeeff',x:1,y:65,z:3,yaw:0,pitch:0})
  const entity=bot.entities[777],nbt={type:'compound',name:'',value:{probe:{type:'string',value:'unchanged'}}}
  bot._client.emit('entity_metadata',{entityId:777,metadata:[{key:base.supportFeature('metadataIxOfItem'),type:'item_stack',value:{present:true,itemId,itemCount:3,nbtData:nbt}}]})
  const stack=entity.getDroppedItem();assert.equal(stack.name,'blind:gem');assert.equal(stack.count,3);assert.deepEqual(stack.nbt,nbt)
  bot._client.emit('entity_equipment',{entityId:777,equipments:[{slot:0,item:{present:true,itemId,itemCount:2,nbtData:nbt}}]})
  assert.equal(entity.equipment[0].name,'blind:gem');assert.equal(entity.equipment[0].count,2);assert.deepEqual(entity.equipment[0].nbt,nbt)
  bridge.destroy();assert.equal(Object.hasOwn(entity,'getDroppedItem'),false);assert.equal(Object.hasOwn(entity,'setEquipment'),false)
  assert.equal(base.items[itemId].name,'stone')
})
test('entity patch references reset on login/world changes/end and are bounded across 100 cycles',()=>{
  const base=require('prismarine-registry')('1.20.1'),mappings=new ServerRegistryMappings(),bot=makeBot(base)
  const bridge=new NativeRegistryBridge({mappings}).attachBot(bot);bridge.attachClient(bot._client);require('mineflayer/lib/plugins/entities')(bot,{})
  install(mappings,[{id:124,name:'lifecycle:actor'}]);bridge.syncRegistry('minecraft:entity_type')
  bot._client.emit('login',{entityId:1,worldName:'minecraft:overworld'})
  const local=bot.entity
  const spawn=id=>bot._client.emit('spawn_entity',{entityId:id,type:124,objectUUID:'00112233-4455-6677-8899-aabbccddeeff',x:1,y:65,z:3,yaw:0,pitch:0})
  for(let i=0;i<100;i++){
    spawn(i+100);assert.equal(bridge.getReport().entityLifecycle.patchedEntityCount,1)
    bot._client.emit('respawn',{worldName:'world:'+i})
    assert.equal(bridge.getReport().entityLifecycle.patchedEntityCount,0)
    assert.equal(bot.entities[i+100],undefined);assert.equal(bot.entity,local)
  }
  spawn(500);bot._client.emit('respawn',{worldName:'world:99'});assert.equal(bridge.getReport().entityLifecycle.patchedEntityCount,1)
  bot._client.emit('login',{entityId:2,worldName:'world:99'});assert.equal(bridge.getReport().entityLifecycle.patchedEntityCount,0);assert.equal(bot.entities[500],undefined)
  spawn(501);const entity=bot.entities[501];bot._client.emit('end','test')
  assert.equal(bridge.getReport().entityLifecycle.patchedEntityCount,0);assert.equal(Object.hasOwn(entity,'setEquipment'),false)
  const before=bot._client.listenerCount('respawn');bridge.destroy();assert.equal(bot._client.listenerCount('respawn'),before-1)
})
