'use strict'
const {instructions}=require('./classfile')
const {signature}=require('./forge-channels')
const DEFERRED='net/minecraftforge/registries/DeferredRegister'
const EVENT='net/minecraftforge/registries/RegisterEvent'
// Resolve wrappers by their standard DeferredRegister sink, not their names.
function discoverDeferredRecipes(classes){
  const methods=new Map(),registrations=[],diagnostics=[],statics=new Map(),initialized=new Set()
  const key=m=>m.owner+'.'+m.name+m.descriptor
  for(const c of classes.values())for(const m of c.methods)if(m.code)methods.set(key({owner:c.thisClass,...m}),{c,m,seq:instructions(c,m)})
  function resolve(owner,name,descriptor){const seen=new Set();while(owner&&!seen.has(owner)){seen.add(owner);const e=methods.get(key({owner,name,descriptor}));if(e)return e;owner=classes.get(owner)?.superClass}}
  const relevant=new Set([...methods].filter(([,e])=>e.seq.some(i=>(i.member?.owner===DEFERRED&&['create','register'].includes(i.member.name))||([EVENT,EVENT+'$RegisterHelper'].includes(i.member?.owner)&&i.member.name==='register'))).map(([k])=>k))
  for(let changed=true;changed;){changed=false;for(const[k,e]of methods)if(!relevant.has(k)&&e.seq.some(i=>{const m=i.member,t=m&&resolve(m.owner,m.name,m.descriptor);return t&&relevant.has(key({owner:t.c.thisClass,...t.m}))})){relevant.add(k);changed=true}}
  const unknown=Object.freeze({unknown:true})
  function evaluate(e,object,args,depth=0,budget={n:40000}){
    if(depth>12)throw new Error('deferred_wrapper_depth_limit')
    if(e.seq.some(i=>i.op>=0x99&&i.op<=0xab||[0xc6,0xc7,0xc8,0xc9].includes(i.op)))throw new Error('deferred_conditional_initialization')
    const stack=[],locals=[];let slot=e.m.flags&8?0:1;if(slot)locals[0]=object
    for(const[i,t]of signature(e.m.descriptor).args.entries()){locals[slot]=args[i]??unknown;slot+=['J','D'].includes(t)?2:1}
    const pop=()=>{if(!stack.length)throw new Error('deferred_unknown_stack');return stack.pop()}
    for(const ins of e.seq){
      if(--budget.n<0)throw new Error('deferred_instruction_limit')
      const op=ins.op
      if(op===0)continue
      if(op===1){stack.push(null);continue}
      if(op>=2&&op<=8){stack.push(op-3);continue}
      if([0x10,0x11].includes(op)){stack.push(ins.number);continue}
      if([0x12,0x13].includes(op)){stack.push(ins.literal??unknown);continue}
      if(op>=0x2a&&op<=0x2d){stack.push(locals[op-0x2a]??unknown);continue}
      if([0x19,0x15].includes(op)){stack.push(locals[ins.localIndex]??unknown);continue}
      if(op>=0x4b&&op<=0x4e){locals[op-0x4b]=pop();continue}
      if(op===0x3a){locals[ins.localIndex]=pop();continue}
      if(op===0x59){const a=pop();stack.push(a,a);continue}
      if(op===0x57){pop();continue}
      if(op===0xc0)continue
      if(op===0xbb){stack.push({objectClass:ins.className,fields:new Map()});continue}
      if(op===0xb2){const id=ins.member.owner+'.'+ins.member.name;if(!statics.has(id)){const init=resolve(ins.member.owner,'<clinit>','()V');if(init&&!initialized.has(ins.member.owner)){initialized.add(ins.member.owner);evaluate(init,null,[],depth+1,budget)}}stack.push(statics.get(id)??{field:ins.member});continue}
      if(op===0xb3){statics.set(ins.member.owner+'.'+ins.member.name,pop());continue}
      if(op===0xb4){const a=pop();stack.push(a?.fields?.get(ins.member.owner+'.'+ins.member.name)??unknown);continue}
      if(op===0xb5){const value=pop(),a=pop();a?.fields?.set(ins.member.owner+'.'+ins.member.name,value);continue}
      if(op===0xba){const captures=signature(ins.descriptor).args.map(()=>pop()).reverse();stack.push({callback:ins.lambda,captures});continue}
      if(op===0xb0)return pop()
      if(op===0xb1)return unknown
      if(![0xb6,0xb7,0xb8,0xb9].includes(op))throw new Error('deferred_unsupported_opcode_'+op.toString(16))
      const m=ins.member,sig=signature(m.descriptor),callArgs=sig.args.map(()=>pop()).reverse(),receiver=op===0xb8?null:pop();let result=unknown
      if(m.owner===DEFERRED&&m.name==='create')result={registry:callArgs[0],namespace:callArgs[1]}
      else if(m.owner==='net/minecraft/resources/ResourceLocation' && m.name==='<init>' && callArgs.every(a=>typeof a==='string'))receiver.resourceLocation=callArgs.length===2?callArgs.join(':'):callArgs[0]
      else if(m.owner===EVENT && m.name==='register' && receiver?.registerEvent && callArgs[0]?.field?.owner==='net/minecraftforge/registries/ForgeRegistries$Keys' && callArgs[0].field.name==='RECIPE_SERIALIZERS') {
        if(sig.args[1]==='Ljava/util/function/Consumer;') {
          const callback=callArgs[1],ref=callback?.callback,target=ref&&resolve(ref.owner,ref.name,ref.descriptor)
          if(target)evaluate(target,null,[...(callback.captures||[]),{recipeHelper:true,namespace:receiver.namespace}],depth+1,budget)
        } else if(callArgs[1]?.resourceLocation && callArgs[2]?.callback) registrations.push({id:callArgs[1].resourceLocation,factory:callArgs[2].callback,registration:{owner:e.c.thisClass,method:e.m.name,offset:ins.offset}})
      }
      else if(m.owner===EVENT+'$RegisterHelper' && m.name==='register' && receiver?.recipeHelper) {
        const name=typeof callArgs[0]==='string'?callArgs[0]:callArgs[0]?.resourceLocation
        const id=typeof name==='string'?(name.includes(':')?name:receiver.namespace+':'+name):null
        if(id && callArgs[1]?.objectClass)registrations.push({id,factory:{owner:callArgs[1].objectClass,name:'<init>'},registration:{owner:e.c.thisClass,method:e.m.name,offset:ins.offset}})
      }
      else if(m.owner===DEFERRED&&m.name==='register'&&sig.args[0]==='Ljava/lang/String;'&&sig.args[1]==='Ljava/util/function/Supplier;'){
        if(receiver?.registry?.field?.owner==='net/minecraftforge/registries/ForgeRegistries'&&receiver.registry.field.name==='RECIPE_SERIALIZERS'&&typeof receiver.namespace==='string'&&typeof callArgs[0]==='string')registrations.push({id:receiver.namespace+':'+callArgs[0],factory:callArgs[1]?.callback,registration:{owner:e.c.thisClass,method:e.m.name,offset:ins.offset}})
      }else{
        const target=resolve(op===0xb7?m.owner:receiver?.objectClass||m.owner,m.name,m.descriptor)
        if(target&&(relevant.has(key({owner:target.c.thisClass,...target.m}))||m.name==='<init>'))result=evaluate(target,receiver,callArgs,depth+1,budget)
      }
      if(sig.result!=='V')stack.push(result)
    }
    return unknown
  }
  for(const e of methods.values())if(e.m.name==='<clinit>'&&relevant.has(key({owner:e.c.thisClass,...e.m}))&&!initialized.has(e.c.thisClass)){
    initialized.add(e.c.thisClass);const before=registrations.length,savedStatics=structuredClone(statics),savedInitialized=new Set(initialized)
    try{evaluate(e,null,[])}catch(error){registrations.length=before;statics.clear();for(const [key,value]of savedStatics)statics.set(key,value);initialized.clear();for(const owner of savedInitialized)initialized.add(owner);diagnostics.push({owner:e.c.thisClass,reason:error.message})}
  }
  for(const e of methods.values()) {
    const subscriber=e.c.annotations?.find(a=>a.type==='Lnet/minecraftforge/fml/common/Mod$EventBusSubscriber;'&&a.values.bus?.name==='MOD')
    if(!subscriber?.values.modid || !(e.m.flags&8) || e.m.descriptor!=='(L'+EVENT+';)V' || !e.m.annotations?.some(a=>a.type==='Lnet/minecraftforge/eventbus/api/SubscribeEvent;'))continue
    const before=registrations.length
    try{evaluate(e,null,[{registerEvent:true,namespace:subscriber.values.modid}])}catch(error){registrations.length=before;diagnostics.push({owner:e.c.thisClass,method:e.m.name,reason:error.message})}
  }
  return {registrations,diagnostics}
}
module.exports={discoverDeferredRecipes}
