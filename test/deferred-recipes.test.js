'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {discoverDeferredRecipes}=require('../src/analyzer/deferred-recipes')
function cls(name,superClass,methods,members,constants={}){return {thisClass:name,superClass,methods:methods.map(m=>({...m,flags:m.flags||0,code:Buffer.from(m.code)})),member:i=>members[i],constant:i=>constants[i],dynamicDescriptor:()=>'()Ljava/util/function/Supplier;',lambdaTarget:()=>({owner:'fixture/Serializer',name:'<init>',descriptor:'()V'})}}
test('DeferredRegister sink resolves arbitrary wrapper names, constructor delegation and inherited registration',()=>{
  const D='net/minecraftforge/registries/DeferredRegister',R='Lnet/minecraftforge/registries/IForgeRegistry;',S='Ljava/lang/String;',U='Ljava/util/function/Supplier;',O='Lnet/minecraftforge/registries/RegistryObject;'
  const field={owner:'fixture/Base',name:'privateField',descriptor:'L'+D+';',tag:9}
  const base=cls('fixture/Base','java/lang/Object',[
    {name:'<init>',descriptor:'('+S+R+')V',code:[0x2a,0x2c,0x2b,0xb8,0,1,0xb5,0,2,0xb1]},
    {name:'deliver',descriptor:'('+S+U+')'+O,code:[0x2a,0xb4,0,2,0x2b,0x2c,0xb6,0,3,0xb0]}
  ],{1:{owner:D,name:'create',descriptor:'('+R+S+')L'+D+';'},2:field,3:{owner:D,name:'register',descriptor:'('+S+U+')'+O}})
  const child=cls('fixture/Child','fixture/Base',[{name:'<init>',descriptor:'('+S+')V',code:[0x2a,0x2b,0xb2,0,1,0xb7,0,2,0xb1]}],{
    1:{owner:'net/minecraftforge/registries/ForgeRegistries',name:'RECIPE_SERIALIZERS',descriptor:R},2:{owner:'fixture/Base',name:'<init>',descriptor:'('+S+R+')V'}})
  const top=cls('fixture/Top','java/lang/Object',[{name:'<clinit>',descriptor:'()V',flags:8,code:[0xbb,0,1,0x59,0x12,2,0xb7,0,3,0xb3,0,4,0xb2,0,4,0x12,5,0xba,0,6,0,0,0xb6,0,7,0x57,0xb1]}],{
    3:{owner:'fixture/Child',name:'<init>',descriptor:'('+S+')V'},4:{owner:'fixture/Top',name:'anything',descriptor:'Lfixture/Child;'},7:{owner:'fixture/Child',name:'deliver',descriptor:'('+S+U+')'+O}
  },{1:{className:'fixture/Child'},2:'unseen',5:'untouched_recipe'})
  const result=discoverDeferredRecipes(new Map([base,child,top].map(c=>[c.thisClass,c])))
  assert.equal(result.registrations.length,1);assert.equal(result.registrations[0].id,'unseen:untouched_recipe');assert.equal(result.registrations[0].factory.owner,'fixture/Serializer')
})
test('real wrapper discovery finds all 30 Mekanism serializers without certifying unknown wire layouts', {skip:!fs.existsSync('../../fixtures/blind-mods/Mekanism-1.20.1-10.4.16.80.jar')},()=>{
  const report=require('../src/analyzer/mod-jar').analyzeJars(['../../fixtures/blind-mods/Mekanism-1.20.1-10.4.16.80.jar'])
  assert.equal(report.recipeSerializers.length,30)
  assert.ok(report.recipeSerializers.find(r=>r.id==='mekanism:enriching').serializer.endsWith('/ItemStackToItemStackRecipeSerializer'))
  assert.equal(report.recipeSerializers.filter(r=>r.status==='candidate').length,9)
  const enriching=report.recipeSerializers.find(r=>r.id==='mekanism:enriching')
  assert.equal(enriching.derivation,'normal-read-control-flow')
  assert.equal(enriching.pairedWriterProven,false)
  assert.equal(enriching.wireEvidence.read.excludedExceptionOffsets.length,7)
  assert.equal(enriching.bindingEvidence[0].kind,'ServiceLoader')
  assert.equal(report.recipeSerializers.find(r=>r.id==='mekanism:pigment_extracting').status,'unresolved')
})
