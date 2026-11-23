'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{EventEmitter}=require('node:events')
const {NativeChannelRuntime}=require('../src/runtime/native-channels')
const flag={experimental:{fml3Runtime:true,forgeJarChannelObservation:true}}
function runtime(){const r=new EventEmitter();r.options={};r.client={version:'1.20.1'};r.fml3Controller={enabled:true,experimentalRegistryFlow:true};return r}
test('wrapper channel requires opt-in and an exact peer match; never inherits peer version or sends payloads',()=>{
  const r=runtime(),compatibility={wrapperChannels:[{id:'unseen:wire',version:'9',policy:'local-supplier-and-exact-peer-version'}]}
  const disabled=new NativeChannelRuntime(r,{},compatibility),enabled=new NativeChannelRuntime(r,flag,compatibility)
  const offered=n=>n.getAdvertisedChannels().filter(c=>c.id==='unseen:wire')
  assert.deepEqual(offered(enabled),[])
  r.fml3={modList:{channels:[{id:'unseen:wire',version:'8'}]}};assert.deepEqual(offered(enabled),[])
  r.fml3.modList.channels[0].version='9';assert.deepEqual(offered(enabled),[{id:'unseen:wire',version:'9'}]);assert.deepEqual(offered(disabled),[])
  assert.deepEqual(enabled.getAdvertisedMods(),[]);assert.throws(()=>enabled.send('unseen:wire',0,{}),/not_registered/)
  assert.equal(enabled.getReport().wrapperChannelDeclarations[0].admitted,true)
  enabled.destroy();disabled.destroy()
})
const balm=process.env.MMR_BALM_JAR||'../../fixtures/mods/balm-forge-1.20.1-7.3.44.jar',waystones=process.env.MMR_WAYSTONES_JAR||'../../fixtures/mods/waystones-forge-1.20.1-14.1.21.jar'
const present=fs.existsSync(balm)&&fs.existsSync(waystones)
test('local wrapper supplies the actual version; a hand-authored manifest or missing implementation cannot grant negotiation',{skip:!present},()=>{
  const {CompatibilityRuntime}=require('../src/runtime/compatibility'),{analyzeJars}=require('../src/analyzer/mod-jar'),{createCompatibilityManifest}=require('../src/analyzer/compatibility-manifest')
  const analysis=analyzeJars([balm,waystones]),declaration=analysis.wrapperChannels.find(c=>c.id==='waystones:network')
  assert.equal(declaration.version,'1.0');assert.equal(declaration.clientBehaviorImplemented,false)
  assert.equal(analyzeJars([waystones]).wrapperChannels.length,0)
  const imported=new CompatibilityRuntime({compatibilityManifest:{...createCompatibilityManifest(analysis),wrapperChannels:analysis.wrapperChannels}})
  assert.deepEqual(imported.wrapperChannels,[])
})
test('wrapper channel extraction follows API call and Supplier bytecode, not private lambda names or a hard-coded version',{skip:!present},()=>{
  const {ZipArchive}=require('../src/analyzer/zip'),{readClass,instructions}=require('../src/analyzer/classfile'),{proveBalmCounter}=require('../src/analyzer/discriminator')
  const z=new ZipArchive(fs.readFileSync(balm)),classes=new Map(z.names().filter(n=>n.endsWith('.class')).map(n=>{const c=readClass(z.read(n));return[c.thisClass,c]}))
  const proof=proveBalmCounter(classes),cls=classes.get(proof.channelVersionDeclaration.factory.owner)
  const factory=cls.methods.find(m=>m.name===proof.channelVersionDeclaration.factory.name),supplier=cls.methods.find(m=>m.name===proof.channelVersionDeclaration.supplier.name)
  const original=cls.lambdaTarget
  const oldName=supplier.name;cls.lambdaTarget=index=>{const value=original(index);return value?.name===oldName?{...value,name:'renamedSupplier'}:value}
  factory.name='renamedFactory';supplier.name='renamedSupplier'
  const oldConstant=cls.constant,constantIndex=supplier.code[1]
  cls.constant=index=>index===constantIndex?'9.7':oldConstant(index)
  assert.equal(proveBalmCounter(classes).channelVersionDeclaration.version,'9.7')
  supplier.code=Buffer.from([0x01,0xb0]);assert.equal(proveBalmCounter(classes).channelVersionDeclaration,null)
  assert.ok(instructions(cls,factory).some(i=>i.member?.owner==='net/minecraftforge/network/NetworkRegistry'))
})
