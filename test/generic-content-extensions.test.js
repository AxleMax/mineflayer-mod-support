'use strict'
const test = require('node:test'), assert = require('node:assert/strict'), { EventEmitter, once } = require('node:events')
const { ModSupportRuntime } = require('..')
const { WireWriter } = require('../src/protocol/forge/wire')
function use (runtime, setup, id = 'blind') { return runtime.use({ apiVersion: 1, id, setup }) }
function bot (runtime) {
  const b = new EventEmitter(); b.registry = require('prismarine-registry')('1.20.1')
  runtime.attachBot(b); return b
}
const shapes = [[[0,0,0,1,1,1]], [[0,0,0,1,.5,1]], [], [[0,.5,0,1,1,1]]]
function definition (minStateId = 50000) {
  return { minStateId, defaultStateId: minStateId, properties: [{ name: 'axis', values: ['x','z'] },{ name: 'wet', values: [true,false] }], collisionShapes: shapes, hardness: 2, diggable: true, transparent: false, boundingBox: 'block' }
}
test('explicit states and collision reach native Block and Chunk without global registry mutation', () => {
  const r = new ModSupportRuntime(), b = bot(r), base = require('prismarine-registry')('1.20.1')
  const before = JSON.stringify(base.blockCollisionShapes), baseBlock = base.blocks[1]
  const off = use(r, ctx => { ctx.defineBlock('blind:lattice', definition()) })
  assert.equal(r.nativeRegistry.blocks.getReport().unresolved[0].reason, 'block_not_in_server_registry')
  r.installRegistry({ name: 'minecraft:block', entries: [{ id: 60000, name: 'blind:lattice' },{id:7000,name:'minecraft:stone'}] })
  const Block = require('prismarine-block')(b.registry)
  const block = Block.fromStateId(50001, 0)
  assert.equal(Block.fromStateId(base.blocksByName.stone.minStateId,0).type,7000)
  assert.equal(block.type, 60000); assert.equal(block.name, 'blind:lattice')
  assert.deepEqual(block.getProperties(), { axis: 'x', wet: false }); assert.deepEqual(block.shapes, shapes[1])
  assert.equal(Block.fromProperties('blind:lattice', { axis: 'z', wet: true }, 0).stateId, 50002)
  r.nativeRegistry.syncRegistry('minecraft:block')
  assert.deepEqual(Block.fromStateId(base.blocksByName.stone.minStateId,0).shapes,[[0,0,0,1,1,1]])
  const Chunk = require('prismarine-chunk')(b.registry), chunk = new Chunk({ minY: 0, worldHeight: 256 }), point = new (require('vec3').Vec3)(1,5,2)
  chunk.setBlockStateId(point, 50003)
  assert.equal(chunk.getBlock(point).name, 'blind:lattice'); assert.deepEqual(chunk.getBlock(point).shapes, shapes[3])
  assert.equal(base.blocks[1], baseBlock); assert.equal(JSON.stringify(base.blockCollisionShapes), before)
  assert.equal(r.nativeRegistry.resolve('block',60000).stateIdsKnown,true)
  off(); assert.equal(b.registry.blocksByStateId[50001],undefined)
  assert.deepEqual(Block.fromStateId(base.blocksByName.stone.minStateId,0).shapes,[[0,0,0,1,1,1]])
  assert.equal(r.nativeRegistry.resolve('block',60000).stateIdsKnown,false)
  r.destroy()
})
test('invalid/overlapping state data is rejected atomically and does not allocate server IDs', () => {
  const r = new ModSupportRuntime(); bot(r)
  const first = use(r, ctx => { ctx.defineBlock('blind:a', definition()) })
  assert.throws(() => use(r, ctx => { ctx.defineBlock('blind:b', definition(50002)) },'second'), /overlapping/)
  assert.equal(r.contentDefinitions.get('block','blind:b'),null)
  assert.equal(r.contentDefinitions.get('block','blind:a').data.minStateId,50000)
  assert.throws(() => use(r, ctx => { ctx.defineBlock('blind:b',{ ...definition(),collisionShapes:[] }) },'bad'),/shape_count/)
  assert.equal(r.registryMappings.getId('minecraft:block','blind:a'),null)
  first();r.destroy()
})
test('dynamic collision adapter reads raw neighbours without recursion or replacing native physics', () => {
  const r=new ModSupportRuntime(),b=bot(r),{Vec3}=require('vec3')
  r.installRegistry({name:'minecraft:block',entries:[{id:60000,name:'blind:lattice'}]})
  use(r,ctx=>{ctx.defineBlock('blind:lattice',definition())})
  const Block=require('prismarine-block')(b.registry)
  let solid=false,calls=0
  const reader=pos=>{
    const value=Block.fromStateId(pos.y===5?50000:solid?b.registry.blocksByName.stone.defaultState:b.registry.blocksByName.air.defaultState,0)
    value.position=pos;return value
  }
  b.blockAt=reader
  const stop=use(r,ctx=>{ctx.registerBlockCollision('blind:lattice',(block,context)=>{
    calls++;const below=context.getBlock(block.position.offset(0,-1,0))
    return below.name==='stone'?[[0,0,0,1,.5,1]]:[]
  })},'dynamic')
  assert.deepEqual(b.blockAt(new Vec3(1,5,2)).shapes,[])
  solid=true;assert.deepEqual(b.blockAt(new Vec3(1,5,2)).shapes,[[0,0,0,1,.5,1]])
  assert.equal(calls,2);assert.deepEqual(Block.fromStateId(50000,0).shapes,shapes[0])
  stop();assert.deepEqual(b.blockAt(new Vec3(1,5,2)).shapes,shapes[0])
  r.destroy();assert.equal(b.blockAt,reader)
})
test('unknown world states emit bounded diagnostics instead of being certified as empty collision', () => {
  const r=new ModSupportRuntime(),b=bot(r),seen=[]
  r.on('unresolvedBlockState',value=>seen.push(value))
  b.blockAt=()=>({stateId:900000,name:'',shapes:[],position:{x:1,y:2,z:3}})
  b.blockAt();b.blockAt()
  assert.equal(seen.length,1);assert.equal(seen[0].collisionKnown,false)
  assert.equal(r.snapshot().blockCollisions.unresolvedStates[0].stateId,900000)
  b.blockAt=()=>({stateId:900000,name:'blind:known',shapes:[[0,0,0,1,1,1]],position:{x:1,y:2,z:3}})
  b.blockAt();assert.equal(r.snapshot().blockCollisions.unresolvedStates.length,0)
  r.destroy()
})
test('Forge registry names select metadata codecs and feed the native Mineflayer entity plugin', async () => {
  const r = new ModSupportRuntime({ experimental:{fml3Runtime:true} })
  r.installRegistry({ name:'forge:entity_data_serializers', entries:[{id:301,name:'blind:pair'}] })
  use(r,ctx=>{ctx.registerProtocolCodec('metadata','blind:pair',['container',[{name:'left',type:'varint'},{name:'right',type:'string'}]])})
  const packetId=Object.entries(require('minecraft-data')('1.20.1').protocol.play.toClient.types.packet[1][0].type[1].mappings).find(([,name])=>name==='entity_metadata')[0]
  const bytes=new WireWriter().varInt(Number(packetId)).varInt(42).byte(17).varInt(301).varInt(7).string('value').byte(255).finish()
  const packet=r.protocolCodecs.decode(bytes,'1.20.1','play')
  assert.deepEqual(packet.data.params.metadata,[{key:17,type:'blind:pair',value:{left:7,right:'value'}}])
  assert.deepEqual(r.protocolCodecs.cache.proto.createPacketBuffer('packet',packet.data),bytes)
  assert.equal(r.protocolCodecs.getReport().synchronization.entityMetadata.status,'last-packet-decoded')
  const b=bot(r),c=new (require('minecraft-protocol').Client)(false,'1.20.1')
  b.version='1.20.1';b.supportFeature=b.registry.supportFeature;b._client=c
  r.attachClient(c);c.state='play'
  require('mineflayer/lib/plugins/entities')(b)
  const update=once(b,'entityUpdate',{signal:AbortSignal.timeout(1000)})
  c.deserializer.write(bytes)
  assert.deepEqual((await update)[0].metadata[17],{left:7,right:'value'})
  r.destroy()
})
test('unknown metadata format fails visibly and the next framed packet remains parseable', async () => {
  const r = new ModSupportRuntime({experimental:{fml3Runtime:true}}),c = new (require('minecraft-protocol').Client)(false,'1.20.1')
  r.installRegistry({name:'forge:entity_data_serializers',entries:[{id:300,name:'blind:unknown'}]})
  r.attachClient(c);c.state='play'
  const proto=r.protocolCodecs._protocol('1.20.1').proto
  const id=proto.createPacketBuffer('packet',{name:'entity_metadata',params:{entityId:9,metadata:[]}})[0]
  const failed=[];r.on('protocolSyncFailed',e=>failed.push(e))
  const next=once(c,'entity_metadata',{signal:AbortSignal.timeout(1000)})
  c.deserializer.write(new WireWriter().varInt(id).varInt(9).byte(5).varInt(300).byte(0).byte(255).finish())
  assert.equal(r.protocolCodecs.getReport().synchronization.entityMetadata.status,'failed')
  c.deserializer.write(proto.createPacketBuffer('packet',{name:'entity_metadata',params:{entityId:10,metadata:[]}}))
  assert.equal((await next)[0].entityId,10)
  assert.equal(failed[0].resource,'blind:unknown');assert.equal(r.packetDecodeFailures[0].packetName,'entity_metadata')
  assert.equal(r.packetDecodeFailures[0].entityId,9)
  r.destroy()
})
const recipeId=()=>new WireWriter().varInt(0x6d).varInt(2).identifier('blind:custom').identifier('blind:first')
const callbackCodec={
  read(buffer,offset,ctx){const flag=buffer.readUInt8(offset),field=flag?ctx.read('string',offset+1):{value:null,size:0};return {value:{present:Boolean(flag),label:field.value},size:1+field.size}},
  write(value,buffer,offset,ctx){buffer[offset++]=value.present?1:0;return value.present?ctx.write('string',value.label,offset):offset},
  sizeOf(value,ctx){return 1+(value.present?ctx.sizeOf('string',value.label):0)}
}
test('explicit custom recipe consumes its format and preserves the following recipe and exact round trip', () => {
  const r=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  use(r,ctx=>{ctx.registerExplicitCodec('recipe','blind:custom',callbackCodec)})
  const bytes=recipeId().byte(1).string('structured').identifier('minecraft:crafting_special_armordye').identifier('blind:second').varInt(0).finish()
  const out=r.protocolCodecs.decode(bytes,'1.20.1','play')
  assert.equal(out.data.params.recipes.length,2);assert.deepEqual(out.data.params.recipes[0].data,{present:true,label:'structured'})
  assert.deepEqual(r.protocolCodecs.cache.proto.createPacketBuffer('packet',out.data),bytes)
  assert.deepEqual(r.protocolCodecs.getReport().synchronization.recipes,{status:'complete',recipes:2})
  r.destroy()
})
test('invalid callback sizes fail without claiming successful recipe synchronization', () => {
  const r=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  use(r,ctx=>{ctx.registerExplicitCodec('recipe','blind:custom',{...callbackCodec,read:()=>({value:{},size:999999})})})
  assert.throws(()=>r.protocolCodecs.decode(recipeId().byte(0).finish(),'1.20.1','play'),/outside_frame/)
  assert.equal(r.protocolCodecs.getReport().synchronization.recipes.status,'failed')
  r.destroy()
})
test('adapter menu rules receive native windows, explicit layout and detached loader context, then clean up', () => {
  const r=new ModSupportRuntime(),b=bot(r),upstream=require('prismarine-windows')(b.registry)
  let closed=0,seen
  const stop=use(r,ctx=>{
    ctx.defineMenu('blind:layout',{slots:50,inventoryStart:8,inventoryEnd:44,craftingResultSlot:3,standardClick:true})
    ctx.registerMenuRules('blind:layout',(window,context)=>{
      seen=context;window.adapterMeaning='explicit';return ()=>{closed++;delete window.adapterMeaning}
    })
  })
  b.currentWindow=upstream.createWindow(5,'blind:layout','Menu',14)
  assert.equal(b.currentWindow.inventoryStart,8);assert.equal(b.currentWindow.inventoryEnd,44);assert.equal(b.currentWindow.craftingResultSlot,3)
  assert.equal(b.currentWindow.adapterMeaning,'explicit');assert.equal(seen.menu,'blind:layout')
  stop();assert.equal(closed,1);assert.equal(b.currentWindow.adapterMeaning,undefined)
  b.currentWindow=null;assert.equal(closed,1);r.destroy()
})
