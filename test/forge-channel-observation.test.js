'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { compileCodecPlan } = require('../src/analyzer/codec-ir')
const { NativeChannelRuntime } = require('../src/runtime/native-channels')
const { GenericPacketDispatcher } = require('../src/runtime/packet-dispatcher')
const { packSimpleChannel } = require('../src/protocol/forge/simple-channel')
const plan = type => ({ schema: 'mineflayer-mod-support/codec-ir/v1', root: { type } })
test('IEEE floating scalars retain wire values and reject nonfinite or overflowing values', () => {
  for (const type of ['float','double']) {
    const c=compileCodecPlan(plan(type))
    for (const n of [0,-0,0.5,-123.25]) assert.ok(Object.is(c.decode(c.encode(n)),n))
    assert.throws(()=>c.encode(NaN));assert.throws(()=>c.encode(Infinity))
    assert.throws(()=>c.decode(Buffer.alloc(type==='float'?3:7)))
  }
  assert.throws(()=>compileCodecPlan(plan('float')).encode(Number.MAX_VALUE),/overflow/)
})
test('opaque registered payloads are bounded observations without guessing resource prefixes', () => {
  const d=new GenericPacketDispatcher(new EventEmitter())
  d.registerObservedMessage({direction:'clientbound',codecStatus:'unresolved',predictedChannel:'sample:wire',predictedDiscriminator:33,opaqueEnvelope:true})
  const r=d.observe({direction:'inbound',phase:'play',channel:'sample:wire',data:packSimpleChannel(33,Buffer.from([0,0]))})
  assert.equal(r.status,'envelope-only');assert.equal(r.data.decodedBody,false);assert.equal(r.data.opaqueBytes,2)
  assert.equal(d.observe({direction:'inbound',phase:'play',channel:'sample:wire',data:packSimpleChannel(34,Buffer.from([0]))}).status,'rejected')
})
function context () {
  const runtime=new EventEmitter();runtime.options={};runtime.client={version:'1.20.1'};runtime.fml3Controller={enabled:true,experimentalRegistryFlow:true}
  const p={direction:'PLAY_TO_CLIENT',className:'sample/Packet',channelBinding:{channel:{name:{resourceLocation:'sample:wire'}}},
    constructorScopedDiscriminator:0,codecStatus:'structural-candidate',codec:{inference:{plan:plan('boolean')}},
    channelIdentity:{id:'sample:wire',version:'7',policy:'exact-equality'}}
  return {runtime,compatibility:{forgeChannels:[{registrations:[p]}]}}
}
test('JAR data defaults to no negotiation; explicit observation mode grants no Mod ID or sends',()=>{
  const {runtime,compatibility}=context()
  const normal=new NativeChannelRuntime(runtime,{},compatibility)
  assert.deepEqual(normal.getAdvertisedChannels(),[])
  const observed=new NativeChannelRuntime(runtime,{experimental:{fml3Runtime:true,forgeJarChannelObservation:true}},compatibility)
  assert.deepEqual(observed.getAdvertisedChannels(),[{id:'forge:split',version:'1.1'},{id:'sample:wire',version:'7'}])
  assert.deepEqual(observed.getAdvertisedMods(),[])
  assert.throws(()=>observed.send('sample:wire',0,true),/not_registered/)
  assert.equal(observed.getReport().forgeJarObservation.clientBehaviorImplemented,false)
})
test('unproven channel version predicates cannot be admitted even in observation mode',()=>{
  const {runtime,compatibility}=context();compatibility.forgeChannels[0].registrations[0].channelIdentity=null
  const observed=new NativeChannelRuntime(runtime,{experimental:{fml3Runtime:true,forgeJarChannelObservation:true}},compatibility)
  assert.deepEqual(observed.getAdvertisedChannels(),[{id:'forge:split',version:'1.1'}])
})

test('real peer lifecycle frames match JAR callback schemas and the independent peer UUID', { skip: !require('node:fs').existsSync('../../verification/forge-standard-derived-channel-live.json') },()=>{
  const report=JSON.parse(require('node:fs').readFileSync('../../verification/forge-standard-derived-channel-live.json','utf8'))
  const source=report.snapshot.compatibility.forgeChannelDiscovery.find(s=>s.source.startsWith('Mekanism-'))
  const crypto=require('node:crypto');const bytes=crypto.createHash('md5').update('OfflinePlayer:ChannelPeer').digest()
  bytes[6]=(bytes[6]&15)|48;bytes[8]=(bytes[8]&63)|128
  const h=bytes.toString('hex');const uuid=`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
  for(const index of [28,32]) {
    const packet=report.snapshot.playWire.samples.find(p=>p.channel==='mekanism:mekanism'&&p.firstByte===index)
    assert.ok(packet,'real lifecycle packet is present')
    const candidate=source.registrations.find(p=>p.constructorScopedDiscriminator===index)
    const codec=compileCodecPlan(candidate.codec.inference.plan)
    const payload=Buffer.from(packet.hex,'hex').subarray(1);const decoded=codec.decode(payload)
    assert.equal(decoded.slot_0,uuid);assert.deepEqual(codec.encode(decoded),payload)
  }
})
