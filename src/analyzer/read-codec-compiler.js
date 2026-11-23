'use strict'
const {createHash}=require('node:crypto')
const {normalInstructions}=require('./normal-control-flow')
const {instructions}=require('./classfile')
const {signature}=require('./forge-channels')
const {extractEnumOrdinals,literalInteger}=require('./bytecode-structure')
const {implementsInterface}=require('./recipe-wire-evidence')
const BUF='net/minecraft/network/FriendlyByteBuf'
const UNKNOWN=Object.freeze({unknown:true}),BUFFER=Object.freeze({buffer:true})
const reads={m_130242_:'varint',m_130267_:'slot',m_130277_:'string',m_130136_:'string',m_130281_:'string',m_130258_:'varlong',readFloat:'f32',readDouble:'f64',readShort:'i16',readInt:'i32',readLong:'i64',readBoolean:'bool'}
const objectType=descriptor=>/^L[^;]+;$/.test(descriptor)?descriptor.slice(1,-1):null
class ReadCodecCompiler {
  constructor(classes,services={}){this.classes=classes;this.services=services;this.definitions={};this.active=new Set();this.values=new Map();this.evidence=[];this.operations=0}
  resolve(owner,name,descriptor){const seen=new Set();while(owner&&!seen.has(owner)){seen.add(owner);const cls=this.classes.get(owner),method=cls?.methods.find(m=>m.name===name&&m.descriptor===descriptor&&m.code);if(method)return {cls,method};owner=cls?.superClass}}
  staticValue(member,depth){
    const key=member.owner+'.'+member.name;if(this.values.has(key))return this.values.get(key)
    if(depth>8)return UNKNOWN
    this.values.set(key,UNKNOWN)
    const cls=this.classes.get(member.owner),init=cls?.methods.find(m=>m.name==='<clinit>'&&m.code)
    if(!init)return UNKNOWN
    const seq=normalInstructions(cls,init).code
    const end=seq.findIndex(i=>i.op===0xb3&&i.member.owner===member.owner&&i.member.name===member.name)
    if(end<0)return UNKNOWN
    const chunk=seq.slice(seq.slice(0,end).findLastIndex(i=>i.op===0xb3)+1,end+1)
    const service=chunk.findIndex(i=>i.member?.owner==='java/util/ServiceLoader'&&i.member.name==='load')
    const providerInterface=service>=1?chunk[service-1].literal?.className:null
    const providers=providerInterface&&this.services[providerInterface]
    if(providers?.length===1&&member.descriptor==='L'+providerInterface+';'&&
      implementsInterface(this.classes,providers[0],providerInterface)&&chunk.length===7&&
      [0x12,0xb8,0xb6,0xba,0xb6,0xc0,0xb3].every((op,i)=>chunk[i].op===op)&&
      chunk[1].member.descriptor==='(Ljava/lang/Class;)Ljava/util/ServiceLoader;'&&
      chunk[2].member?.owner==='java/util/ServiceLoader'&&chunk[2].member.name==='findFirst'&&chunk[2].member.descriptor==='()Ljava/util/Optional;'&&
      chunk[3].descriptor==='()Ljava/util/function/Supplier;'&&
      chunk[4].member?.owner==='java/util/Optional'&&chunk[4].member.name==='orElseThrow'&&chunk[4].member.descriptor==='(Ljava/util/function/Supplier;)Ljava/lang/Object;'&&
      chunk[5].className===providerInterface){
      const value={owner:providers[0]};this.values.set(key,value);this.evidence.push({kind:'ServiceLoader',interface:providerInterface,provider:providers[0]});return value
    }
    if(chunk[0]?.op===0xbb&&chunk[1]?.op===0x59&&chunk[2]?.op===0xb7&&chunk[2].member.name==='<init>'&&chunk[2].member.descriptor==='()V'&&chunk.length===4){const value={owner:chunk[0].className};this.values.set(key,value);return value}
    return UNKNOWN
  }
  pure(entry,receiver,args,depth=0){
    if(!entry||depth>8)return UNKNOWN
    const code=normalInstructions(entry.cls,entry.method).code
    if(code.some(i=>i.target!==undefined||[0xaa,0xab,0xbf].includes(i.op)))return UNKNOWN
    const state=this.state(entry,receiver,args);const result=this.run(entry,state,0,depth,true)
    return result.result
  }
  state(entry,receiver,args){const locals=[];let slot=entry.method.flags&8?0:1;if(slot)locals[0]=receiver||UNKNOWN
    for(const [i,t]of signature(entry.method.descriptor).args.entries()){locals[slot]=args[i]??UNKNOWN;slot+=['J','D'].includes(t)?2:1}
    return {locals,stack:[],fields:[]}
  }
  reference(entry,receiver,args,depth=0){
    if(depth>16)throw new Error('read_codec_depth_limit')
    const key=entry.cls.thisClass+'.'+entry.method.name+entry.method.descriptor+'@'+JSON.stringify({receiver,args})
    const name='mmr_read_'+createHash('sha256').update(key).digest('hex').slice(0,24)
    if(this.active.has(name)||this.definitions[name])return name
    this.active.add(name)
    const result=this.run(entry,this.state(entry,receiver,args),0,depth,false)
    if(!result.fields.length)throw new Error('empty_read_schema_not_proven:'+key)
    this.definitions[name]=['container',result.fields];this.active.delete(name)
    return name
  }
  arrayHelper(entry){
    if(!entry)return false
    const c=normalInstructions(entry.cls,entry.method).code
    // Prove allocation count, bound, step and callback-buffer argument in the
    // standard IntFunction/Function counted-array idiom. No helper name rule.
    const ops=[43,42,182,185,192,78,3,54,21,45,190,162,45,21,44,42,185,83,132,167,45,176]
    return c.length===ops.length&&c.every((i,n)=>i.op===ops[n])&&c[2].member?.owner===BUF&&c[2].member.name==='m_130242_'&&
      c[3].member?.owner==='java/util/function/IntFunction'&&c[3].member.name==='apply'&&c[16].member?.owner==='java/util/function/Function'&&c[16].member.name==='apply'&&
      c[11].target===c[20].offset&&c[19].target===c[8].offset&&c[18].increment===1&&[7,8,13,18].every(n=>c[n].localIndex===4)
  }
  switchMap(member,enumOwner){
    const cls=this.classes.get(member?.owner),init=cls?.methods.find(m=>m.name==='<clinit>'&&m.code),result={}
    const enumValues=extractEnumOrdinals(this.classes,enumOwner)
    if(!init||enumValues.status!=='static-evidence')throw new Error('enum_switch_mapping_unresolved')
    const seq=instructions(cls,init)
    for(let i=0;i<seq.length;i++)if(seq[i].op===0x4f){const a=seq.slice(i-4,i)
      if(a[0]?.op!==0xb2||a[0].member.owner!==member.owner||a[0].member.name!==member.name||a[1]?.op!==0xb2||a[1].member.owner!==enumOwner||a[2]?.member?.name!=='ordinal')continue
      const index=enumValues.values.indexOf(a[1].member.name),value=literalInteger(a[3]);if(index<0||value===null||result[index]!==undefined)throw new Error('invalid_enum_switch_mapping');result[index]=value
    }
    if(Object.keys(result).length!==enumValues.values.length)throw new Error('incomplete_enum_switch_mapping')
    return result
  }
  run(entry,state,start,depth,pure){
    const code=normalInstructions(entry.cls,entry.method).code,indexByOffset=new Map(code.map((i,n)=>[i.offset,n]))
    const pop=()=>{if(!state.stack.length)throw new Error('unknown_read_stack:'+entry.cls.thisClass+'.'+entry.method.name);return state.stack.pop()}
    const field=(type,details={})=>{const name='field_'+state.fields.length;state.fields.push({name,type});return {...details,wire:name}}
    for(let pc=start;pc<code.length;pc++){
      if(++this.operations>50000)throw new Error('read_codec_instruction_limit')
      const ins=code[pc],op=ins.op
      if(op===0)continue
      if(op===1){state.stack.push(null);continue}
      if(op>=2&&op<=8){state.stack.push(op-3);continue}
      if([0x10,0x11].includes(op)){state.stack.push(ins.number);continue}
      if([0x12,0x13].includes(op)){state.stack.push(ins.literal??UNKNOWN);continue}
      if([0x15,0x16,0x17,0x18,0x19].includes(op)){state.stack.push(state.locals[ins.localIndex]??UNKNOWN);continue}
      if(op>=0x1a&&op<=0x2d){const offset=(op-0x1a)%4;state.stack.push(state.locals[offset]??UNKNOWN);continue}
      if(op>=0x36&&op<=0x3a){state.locals[ins.localIndex]=pop();continue}
      if(op>=0x3b&&op<=0x4e){state.locals[(op-0x3b)%4]=pop();continue}
      if(op===0x57){pop();continue}
      if(op===0x59){const a=pop();state.stack.push(a,a);continue}
      if(op===0xbb){state.stack.push({owner:ins.className});continue}
      if(op===0xc0)continue
      if(op===0xb2){state.stack.push(this.staticValue(ins.member,depth+1)?.unknown?{owner:objectType(ins.member.descriptor),field:ins.member}:this.staticValue(ins.member,depth+1));continue}
      if(op===0xb3){this.values.set(ins.member.owner+'.'+ins.member.name,pop());continue}
      if(op===0xb4){pop();state.stack.push({owner:objectType(ins.member.descriptor),field:ins.member});continue}
      if(op===0xb5){pop();pop();continue}
      if(op===0xba){const captures=signature(ins.descriptor).args.map(()=>pop()).reverse();state.stack.push({callback:ins.lambda,captures});continue}
      if(op===0x2e){const ordinal=pop(),map=pop();if(!ordinal?.wire||!map?.field)throw new Error('unresolved_array_lookup');state.stack.push({wire:ordinal.wire,switchMap:this.switchMap(map.field,ordinal.enumOwner)});continue}
      if(op===0xa7){const target=indexByOffset.get(ins.target);if(target===undefined||target<=pc)throw new Error('read_loop_requires_structural_rule');pc=target-1;continue}
      if(op===0xaa||op===0xab){
        if(pure)throw new Error('unknown_pure_switch')
        const selector=pop();if(!selector.wire||!selector.switchMap)throw new Error('wire_switch_selector_unresolved')
        const branches={}
        for(const [ordinal,value]of Object.entries(selector.switchMap)){
          const branch=ins.cases.find(c=>c.value===value);if(!branch)throw new Error('wire_enum_case_missing')
          const next={locals:[...state.locals],stack:[...state.stack],fields:[]}
          const out=this.run(entry,next,indexByOffset.get(branch.target),depth+1,false)
          branches[ordinal]=['container',out.fields]
        }
        state.fields.push({name:'field_'+state.fields.length,type:['switch',{compareTo:selector.wire,fields:branches,default:'unsupported_mod_protocol_type'}]})
        return {fields:state.fields,result:{owner:objectType(signature(entry.method.descriptor).result)}}
      }
      if([0xac,0xad,0xae,0xaf,0xb0].includes(op))return {fields:state.fields,result:pop()}
      if(op===0xb1)return {fields:state.fields,result:UNKNOWN}
      if(![0xb6,0xb7,0xb8,0xb9].includes(op))throw new Error('unsupported_read_opcode_'+op.toString(16)+':'+entry.cls.thisClass+'.'+entry.method.name)
      const m=ins.member,sig=signature(m.descriptor),args=sig.args.map(()=>pop()).reverse(),receiver=op===0xb8?null:pop();let result=UNKNOWN
      if(m.owner===BUF){
        if(pure)throw new Error('pure_method_accesses_wire')
        if(!receiver?.buffer)throw new Error('unbound_buffer_receiver')
        if(m.name==='m_130066_'){const enumOwner=args[0]?.className;if(extractEnumOrdinals(this.classes,enumOwner).status!=='static-evidence')throw new Error('wire_enum_unresolved');result=field('varint',{enumOwner})}
        else if(reads[m.name])result=field(reads[m.name])
        else throw new Error('unsupported_friendly_buffer_method:'+m.name)
      }else if(receiver?.buffer)throw new Error('unsupported_buffer_receiver_method:'+m.owner+'.'+m.name)
      else if(m.owner==='net/minecraft/world/item/crafting/Ingredient'&&m.name==='m_43940_')result=field('ingredient')
      else if(m.name==='ordinal'&&receiver?.enumOwner)result=receiver
      else if(m.owner==='java/util/Objects'&&m.name==='requireNonNull')result=args[0]
      else {
        const target=this.resolve(op===0xb7?m.owner:receiver?.owner||m.owner,m.name,m.descriptor)
        const hasBuffer=args.some(a=>a?.buffer)
        if(hasBuffer){
          if(pure)throw new Error('pure_method_accesses_wire')
          if(this.arrayHelper(target)){
            const callback=args[2],ref=callback?.callback,child=ref&&this.resolve(callback.captures?.[0]?.owner||ref.owner,ref.name,ref.descriptor)
            if(!child)throw new Error('array_element_callback_unresolved')
            const name=this.reference(child,callback.captures?.[0]||{owner:child.cls.thisClass},[BUFFER],depth+1)
            result=field(['array',{countType:'varint',type:name}])
          }else{
            if(!target)throw new Error('read_buffer_delegate_unresolved:'+m.owner+'.'+m.name)
            const name=this.reference(target,receiver,args,depth+1);result=field(name,{owner:objectType(sig.result)})
          }
        }else if(target&&m.name!=='<init>')result=this.pure(target,receiver,args,depth+1)
      }
      if(sig.result!=='V')state.stack.push(result)
    }
    return {fields:state.fields,result:UNKNOWN}
  }
  compile(entry,concreteOwner){
    const root=this.reference(entry,{owner:concreteOwner},signature(entry.method.descriptor).args.map(t=>t==='L'+BUF+';'?BUFFER:UNKNOWN))
    return {schema:root,definitions:this.definitions,evidence:this.evidence,derivation:'normal-read-control-flow',pairedWriterProven:false}
  }
}
module.exports={ReadCodecCompiler}
