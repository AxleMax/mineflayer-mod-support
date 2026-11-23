'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {analyzeJars}=require('../src/analyzer/mod-jar')
const folder='../../fixtures/five-mods/',files=['ironchest-1.20.1-14.4.4.jar','constructionwand-1.20.1-2.11.jar','carryon-forge-1.20.1-2.1.2.7.jar','guardvillagers-1.20.1-1.6.19.jar']
const present=files.every(f=>fs.existsSync(folder+f))
function classes(file){const {ZipArchive}=require('../src/analyzer/zip'),{readClass}=require('../src/analyzer/classfile'),z=new ZipArchive(fs.readFileSync(folder+file));return new Map(z.names().filter(n=>n.endsWith('.class')).map(n=>{const c=readClass(z.read(n));return[c.thisClass,c]}))}
test('standard channel wrappers, static initialization and local counters retain exact identities; holdout also passes',{skip:!present},()=>{
  for(const [i,id,n] of [[0,'ironchest:network',1],[1,'constructionwand:main',3],[3,'guardvillagers:main',3]]){
    const report=analyzeJars([folder+files[i]]),messages=report.forgeChannels.flatMap(f=>f.registrations).filter(m=>m.channelIdentity?.id===id)
    assert.equal(messages.length,n);assert.deepEqual(messages.map(m=>m.constructorScopedDiscriminator),Array.from({length:n},(_,i)=>i))
    assert.ok(messages.every(m=>m.channelIdentity.version==='1'&&!m.canAdvertise&&m.handlerStatus==='not-implemented'))
  }
})
test('SPI channel receiver requires a unique declared provider, not a matching implementation name',{skip:!present},()=>{
  const {discoverForgeChannels}=require('../src/analyzer/forge-channels'),cs=classes(files[2]),report=analyzeJars([folder+files[2]]),providers=report.artifacts[0].serviceProviders
  const resolved=discoverForgeChannels(cs,{serviceProviders:providers})
  assert.equal(resolved.registrations.filter(m=>m.channelIdentity?.id==='carryon:carryonpackets').length,3)
  const ambiguous=structuredClone(providers);for(const key of Object.keys(ambiguous))ambiguous[key].push('unseen/OtherProvider')
  assert.ok(discoverForgeChannels(cs,{serviceProviders:ambiguous}).registrations.every(m=>!m.channelIdentity))
})
test('RegisterEvent discovery requires the MOD bus, SubscribeEvent and the recipe registry key',{skip:!present},()=>{
  const {discoverRecipeSerializers}=require('../src/analyzer/recipe-serializers')
  const cs=classes(files[1]),find=()=>discoverRecipeSerializers(cs).find(r=>r.id==='constructionwand:wand_upgrade')
  assert.equal(find().serializer,'net/minecraft/world/item/crafting/SimpleCraftingRecipeSerializer')
  const subscriber=[...cs.values()].find(c=>c.annotations?.some(a=>a.values.modid==='constructionwand'&&a.values.bus?.name==='MOD'))
  const annotation=subscriber.annotations.find(a=>a.values.modid==='constructionwand'&&a.values.bus);annotation.values.bus.name='FORGE';assert.equal(find(),undefined)
  annotation.values.bus.name='MOD'
  const method=subscriber.methods.find(m=>m.descriptor==='(Lnet/minecraftforge/registries/RegisterEvent;)V'&&require('../src/analyzer/classfile').instructions(subscriber,m).some(i=>i.member?.name==='RECIPE_SERIALIZERS'))
  const saved=method.annotations;method.annotations=[];assert.equal(find(),undefined);method.annotations=saved
  const original=subscriber.member;subscriber.member=index=>{const value=original(index);return value?.owner==='net/minecraftforge/registries/ForgeRegistries$Keys'&&value.name==='RECIPE_SERIALIZERS'?{...value,name:'ITEMS'}:value};assert.equal(find(),undefined)
})
const capture='../../verification/five-mods/live-capture/'
test('five-mod server recipe frame decodes and round-trips without a custom adapter',{skip:!present||!fs.existsSync(capture+'declare-recipes.bin')},()=>{
  const {ModSupportRuntime}=require('../src/core/runtime'),runtime=new ModSupportRuntime({modsDir:folder,experimental:{fml3Runtime:true}})
  try{const entries=JSON.parse(fs.readFileSync(capture+'registry.json'));runtime.registryMappings.getEntries=name=>name==='minecraft:recipe_serializer'?entries:[]
    const bytes=fs.readFileSync(capture+'declare-recipes.bin'),packet=runtime.protocolCodecs.decode(bytes,'1.20.1','play')
    assert.equal(packet.data.params.recipes.length,1250)
    assert.equal(packet.data.params.recipes.filter(r=>r.type==='ironfurnaces:generator_blasting').length,12)
    assert.equal(packet.data.params.recipes.filter(r=>r.type==='constructionwand:wand_upgrade').length,1)
    assert.deepEqual(runtime.protocolCodecs.cache.proto.createPacketBuffer('packet',packet.data),bytes)
  }finally{runtime.destroy()}
})
