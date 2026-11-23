'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {ForgeSplitRuntime}=require('../src/protocol/forge/split-packets')
const {ForgeContainerBridge,decodeOpenContainer}=require('../src/protocol/forge/open-container')
const {WireWriter}=require('../src/protocol/forge/wire')
function context(){const runtime=new EventEmitter();runtime.client=new EventEmitter();runtime.client.version='1.20.1';runtime.bot=new EventEmitter();runtime.bot.registry=require('prismarine-registry')('1.20.1');runtime.registryMappings={getName:(_,id)=>({9:'minecraft:generic_9x3',99:'blind:machine'})[id]};return runtime}
function event(channel,data){return {channel,data,direction:'inbound',phase:'play'}}
test('Forge split >2MiB reaches the existing NMP parser exactly once with unchanged bytes',async()=>{
  const mc=require('minecraft-protocol'),runtime=context();runtime.client.deserializer=mc.createDeserializer({state:'play',isServer:false,version:'1.20.1'})
  const proto=mc.createSerializer({state:'play',isServer:true,version:'1.20.1'})
  const body=Buffer.alloc(2200000,123),packet=proto.createPacketBuffer({name:'custom_payload',params:{channel:'blind:wire',data:body}})
  const outputs=[];runtime.client.deserializer.on('data',p=>outputs.push(p))
  const split=new ForgeSplitRuntime(runtime)
  const parts=[];for(let p=0;p<packet.length;p+=800000)parts.push(packet.subarray(p,p+800000))
  for(let i=0;i<parts.length;i++)split.observe(event('forge:split',Buffer.concat([Buffer.from([i===0?1:i===parts.length-1?2:0]),parts[i]])))
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(outputs.length,1);assert.equal(outputs[0].data.params.channel,'blind:wire');assert.deepEqual(outputs[0].data.params.data,body)
  assert.equal(split.getReport().pendingBytes,0);assert.equal(split.getReport().reassembled,1);split.destroy()
})
test('split state is per runtime, rejects missing first and releases pending buffers on end/timeout',async()=>{
  const r=context(),a=new ForgeSplitRuntime(r,{timeoutMs:5}),b=new ForgeSplitRuntime(context())
  assert.equal(a.observe(event('forge:split',Buffer.from([2,4]))).status,'rejected')
  a.observe(event('forge:split',Buffer.from([1,4])));assert.equal(b.getReport().pendingBytes,0)
  await new Promise(resolve=>setTimeout(resolve,15));assert.equal(a.getReport().pendingBytes,0);assert.equal(a.getReport().expired,1)
  a.observe(event('forge:split',Buffer.from([1,4])));r.emit('end');assert.equal(a.getReport().pendingBytes,0);a.destroy();b.destroy()
})
function container(menuId,windowId,extra=Buffer.alloc(0)){return new WireWriter().byte(1).varInt(menuId).varInt(windowId).string('{"text":"Title"}',262144).varInt(extra.length).bytes(extra).finish()}
test('OpenContainer translates vanilla menu identity without assuming server numeric IDs',()=>{
  const r=context(),b=new ForgeContainerBridge(r),packets=[];r.client.on('open_window',p=>packets.push(p));b.attachClient(r.client)
  assert.equal(b.observe(event('fml:play',container(9,2))).status,'handled')
  assert.equal(packets[0].inventoryType,'minecraft:generic_9x3');assert.equal(packets[0].windowId,2);assert.equal(b.getCurrent().slotLayoutKnown,true)
  b.destroy();assert.equal(r.client.listenerCount('window_items'),0)
})
test('custom container preserves additional bytes and actual ItemStacks without guessing slot layout',()=>{
  const r=context(),b=new ForgeContainerBridge(r);b.attachClient(r.client);let native=0;r.client.on('open_window',()=>native++)
  assert.equal(b.observe(event('fml:play',container(99,3,Buffer.from([4,5])))).status,'envelope-only')
  r.client.emit('window_items',{windowId:3,stateId:5,items:[{present:true,itemId:r.bot.registry.itemsByName.stone.id,itemCount:7,nbtData:null}]})
  const value=b.getCurrent();assert.equal(value.menu,'blind:machine');assert.equal(value.readOnly,true);assert.equal(value.items[0].count,7);assert.equal(native,0)
  value.items[0].count=1;assert.equal(b.getCurrent().items[0].count,7)
  r.client.emit('close_window',{windowId:3});assert.equal(b.getCurrent(),null);b.destroy()
  assert.throws(()=>decodeOpenContainer(container(99,3).subarray(1,-1)))
})
