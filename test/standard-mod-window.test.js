'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {ForgeContainerBridge}=require('../src/protocol/forge/open-container')
test('standard OpenScreen projects synced menu IDs with explicit layouts and preserves unknown menus as read-only',()=>{
  const runtime=new EventEmitter(),client=new EventEmitter(),registry=require('prismarine-registry')('1.20.1'),windows=require('prismarine-windows')(registry)
  runtime.bot=new EventEmitter();runtime.bot.registry=registry;runtime.bot.currentWindow=null
  const entries=[{id:40,name:'unseen:box'},{id:41,name:'unseen:special'},{id:0,name:'minecraft:generic_9x1'}]
  runtime.registryMappings={getName:(_,id)=>entries.find(e=>e.id===id)?.name||null,getEntries:()=>entries}
  runtime.contentDefinitions={get:(_,id)=>id==='unseen:box'?{source:'adapter:test',data:{containerSlots:54,playerInventory:'appended-36',standardClick:true}}:null}
  const bridge=new ForgeContainerBridge(runtime),original=client.emit;bridge.attachClient(client)
  const native=[],observed=[];runtime.on('forgeContainerOpened',e=>observed.push(e))
  client.on('open_window',p=>{const window=windows.createWindow(p.windowId,p.inventoryType,p.windowTitle,p.slotCount);assert.ok(window);runtime.bot.currentWindow=window;native.push(window)})
  client.emit('open_window',{windowId:1,inventoryType:40,windowTitle:'{}'})
  assert.equal(native[0].type,'unseen:box');assert.equal(native[0].slots.length,90);assert.equal(native[0].inventoryStart,54)
  client.emit('open_window',{windowId:2,inventoryType:41,windowTitle:'{}'})
  assert.equal(native.length,1);assert.equal(runtime.bot.currentWindow,null);assert.equal(observed.at(-1).readOnly,true)
  client.emit('window_items',{windowId:2,stateId:3,items:[]});assert.equal(bridge.getCurrent().stateId,3)
  client.emit('open_window',{windowId:3,inventoryType:0,windowTitle:'{}'});assert.equal(native.at(-1).type,'minecraft:generic_9x1')
  const diagnostics=[];runtime.on('forgeContainerError',e=>diagnostics.push(e))
  client.emit('open_window',{windowId:4,inventoryType:9999,windowTitle:'{}'})
  assert.equal(diagnostics[0].reason,'container_menu_not_registered:9999');assert.equal(bridge.getCurrent().readOnly,true)
  assert.equal(native.length,2);bridge.destroy();assert.equal(client.emit,original)
  assert.equal(client.listenerCount('window_items'),0);assert.equal(runtime.listenerCount('outgoingPacket'),0)
})
