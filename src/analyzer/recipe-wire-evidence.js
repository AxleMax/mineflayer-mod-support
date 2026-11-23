'use strict'
const {normalInstructions}=require('./normal-control-flow')
const {signature}=require('./forge-channels')
const BUFFER='net/minecraft/network/FriendlyByteBuf'
const VANILLA_FIELDS=Object.freeze({f_44076_:'minecraft:crafting_shaped',f_44077_:'minecraft:crafting_shapeless',f_266093_:'minecraft:smithing_transform',f_265968_:'minecraft:smithing_trim'})
// These are versioned public RecipeSerializer fields, not extension class names.
function vanillaRecipeDelegate(read,write){
  function target(entry,direction){
    if(!entry)return null
    const {code}=normalInstructions(entry.cls,entry.method)
    const calls=code.filter(i=>i.member&&signature(i.member.descriptor).args.includes('L'+BUFFER+';'))
    if(calls.length!==1)return null
    const call=calls[0],m=call.member,expected=direction==='read'?'m_8005_':'m_6178_'
    if(m.owner!=='net/minecraft/world/item/crafting/RecipeSerializer'||m.name!==expected)return null
    if(code.some(i=>i.target!==undefined&&i.op!==0xa7)||code.some(i=>[0xaa,0xab,0xbf,0xba].includes(i.op)))return null
    const field=code.slice(0,code.indexOf(call)).findLast(i=>i.op===0xb2&&i.member.owner===m.owner)
    return field&&VANILLA_FIELDS[field.member.name]||null
  }
  const incoming=target(read,'read'),outgoing=target(write,'write')
  return incoming&&incoming===outgoing?incoming:null
}
function wireEvidence(classes,entry,direction,depth=0,seen=new Set(),budget={remaining:256}){
  if(--budget.remaining<0)return {status:'unresolved',reason:'codec_evidence_node_limit'}
  if(!entry)return {status:'unresolved',reason:'network_method_missing'}
  const id=entry.cls.thisClass+'.'+entry.method.name+entry.method.descriptor
  if(seen.has(id))return {status:'unresolved',reason:'recursive_codec',owner:entry.cls.thisClass,method:entry.method.name}
  if(depth>6)return {status:'unresolved',reason:'codec_call_depth_limit'}
  const flow=normalInstructions(entry.cls,entry.method),next=new Set([...seen,id]),dependencies=[]
  for(const ins of flow.code){
    const m=ins.member
    if(!m||m.tag===9||!m.descriptor.includes('L'+BUFFER+';')||m.owner===BUFFER)continue
    if(m.owner==='net/minecraft/world/item/crafting/Ingredient'&&['m_43940_','m_43923_'].includes(m.name)){dependencies.push({offset:ins.offset,status:'standard',owner:m.owner,method:m.name});continue}
    let owner=m.owner,child
    const visited=new Set()
    while(owner&&!visited.has(owner)){
      visited.add(owner);const cls=classes.get(owner),method=cls?.methods.find(f=>f.name===m.name&&f.descriptor===m.descriptor&&f.code)
      if(method){child={cls,method};break}owner=cls?.superClass
    }
    // Expose implementation candidates for interface calls, but do not pick
    // one merely because it is found in the same archive.
    const implementations=[]
    if(!child&&ins.op===0xb9)for(const cls of classes.values()){
      const method=cls.methods.find(f=>f.name===m.name&&f.code&&signature(f.descriptor).args.join()===signature(m.descriptor).args.join())
      if(method&&implementsInterface(classes,cls.thisClass,m.owner))implementations.push({owner:cls.thisClass,method:method.name,descriptor:method.descriptor})
    }
    dependencies.push({offset:ins.offset,owner:m.owner,method:m.name,descriptor:m.descriptor,
      status:child?'resolved':'unresolved',reason:child?null:ins.op===0xb9?'interface_receiver_binding_required':'external_or_abstract_buffer_delegate',
      implementations,child:child?wireEvidence(classes,child,direction,depth+1,next,budget):null})
  }
  return {status:'analyzed-normal-flow',owner:entry.cls.thisClass,method:entry.method.name,descriptor:entry.method.descriptor,
    excludedExceptionOffsets:flow.excluded,exceptionHandlers:flow.exceptionHandlers,
    switches:flow.code.filter(i=>[0xaa,0xab].includes(i.op)).map(i=>({offset:i.offset,cases:i.cases,defaultTarget:i.defaultTarget})),
    branches:flow.code.filter(i=>i.target!==undefined).map(i=>({offset:i.offset,opcode:i.op,target:i.target})),dependencies}
}
function implementsInterface(classes,owner,target,seen=new Set()){
  if(owner===target)return true
  if(!owner||seen.has(owner))return false
  seen.add(owner);const c=classes.get(owner)
  return [c?.superClass,...(c?.interfaces||[])].some(parent=>implementsInterface(classes,parent,target,seen))
}
module.exports={vanillaRecipeDelegate,wireEvidence,implementsInterface}
