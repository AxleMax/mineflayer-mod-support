'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { discoverForgeChannels } = require('../src/analyzer/forge-channels')
const SIMPLE = 'net/minecraftforge/network/simple/SimpleChannel'
const desc = '(ILjava/lang/Class;Ljava/util/function/BiConsumer;Ljava/util/function/Function;Ljava/util/function/BiConsumer;)V'
function fixture ({ inherited = true, branch = false } = {}) {
  // Arbitrary wrapper and callback names, with parameter reordering.
  const root = {thisClass:'sample/Base',superClass:null,methods:[{name:'route',descriptor:'(Ljava/lang/Class;)V',flags:0,code:Buffer.from([1])}]}
  const child = {thisClass:'sample/Child',superClass:inherited ? root.thisClass : null,methods:[{name:'boot',descriptor:'()V',flags:0,code:Buffer.from([2])}]}
  // Use actual classfile instruction decoding through minimal constant-pool hooks.
  root.methods[0].code=Buffer.from([0x2a,5,0x2b,0xba,0,1,0,0,0xba,0,2,0,0,0xba,0,3,0,0,0xb6,0,4,0xb1])
  root.lambdaTarget=i=>({owner:'sample/Packet',name:['','writeAnything','parseAnything','onAnything'][i],descriptor:'()V'})
  root.dynamicDescriptor=()=>'()Ljava/lang/Object;'
  root.member=()=>({owner:SIMPLE,name:'registerMessage',descriptor:desc})
  child.methods[0].code=Buffer.from([...(branch?[0x99,0,0]:[]),0x2a,0x12,1,0xb6,0,2,0xb1])
  child.constant=()=>({className:'sample/Packet'})
  child.member=()=>({owner:'sample/Child',name:'route',descriptor:'(Ljava/lang/Class;)V'})
  return new Map([[root.thisClass,root],[child.thisClass,child]])
}
test('standard Forge sink resolves inherited wrappers and arbitrary callback method names',()=>{
  const r=discoverForgeChannels(fixture())
  assert.equal(r.registrations.length,1)
  const p=r.registrations[0]
  assert.equal(p.className,'sample/Packet'); assert.equal(p.numericDiscriminator,2)
  assert.equal(p.encoder.callback.name,'writeAnything'); assert.equal(p.decoder.callback.name,'parseAnything')
  assert.equal(p.trace.length,2); assert.equal(p.canAdvertise,false)
})
test('missing superclass link does not invent wrapper behavior',()=>assert.equal(discoverForgeChannels(fixture({inherited:false})).registrations.length,0))
test('conditional registration emits a diagnostic and no invented registration',()=>{
  const r=discoverForgeChannels(fixture({branch:true}))
  assert.equal(r.registrations.length,0); assert.ok(r.diagnostics.some(d=>d.reason==='conditional-or-loop-registration'))
})
test('real Mekanism sink discovery retains unresolved lifecycle and never grants advertisement', { skip: !require('node:fs').existsSync('../../fixtures/blind-mods/Mekanism-1.20.1-10.4.16.80.jar') }, ()=>{
  const file='../../fixtures/blind-mods/Mekanism-1.20.1-10.4.16.80.jar'
  const {analyzeJars}=require('../src/analyzer/mod-jar'); const r=analyzeJars([file]).forgeChannels[0]
  assert.equal(r.registrations.length,39)
  assert.deepEqual(r.registrations.map(p=>p.constructorScopedDiscriminator),Array.from({length:39},(_,i)=>i))
  assert.deepEqual(r.registrations[0].channelIdentity,{id:'mekanism:mekanism',version:'10.4.16',policy:'exact-equality',evidence:'constructor-supplier-and-both-version-predicates'})
  assert.ok(r.registrations.every(p=>p.entryCallSites.length===1 && p.entryCallSites[0].descriptor.includes('FMLCommonSetupEvent')))
  assert.equal(r.registrations.filter(p=>p.direction==='PLAY_TO_CLIENT'&&p.codecStatus==='structural-candidate').length,4)
  assert.deepEqual(r.registrations.map(p=>p.discriminator.increment || 0),Array.from({length:39},(_,i)=>i))
  assert.equal(r.registrations.filter(p=>p.direction==='PLAY_TO_CLIENT').length,13)
  assert.ok(r.registrations.every(p=>p.numericDiscriminator===null && p.decoder.callback && p.encoder.resolvedCallback && !p.canAdvertise))
  assert.ok(r.registrations.every(p=>p.unresolved.includes('discriminator-initialization-and-lifecycle-not-proven')))
})
