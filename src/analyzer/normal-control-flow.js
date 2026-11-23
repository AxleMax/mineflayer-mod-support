'use strict'
const {instructions}=require('./classfile')
// Normal (nonexceptional) control-flow reachability. Catch code is excluded
// only when unreachable from entry; shared finally code remains reachable.
function normalInstructions(cls,method){
  const seq=instructions(cls,method),byOffset=new Map(seq.map((i,n)=>[i.offset,n])),seen=new Set(),pending=seq.length?[0]:[]
  while(pending.length){
    const index=pending.pop();if(seen.has(index))continue
    const ins=seq[index];if(!ins)throw new Error('invalid_normal_control_flow_target')
    seen.add(index)
    const target=offset=>{const n=byOffset.get(offset);if(n===undefined)throw new Error('invalid_normal_control_flow_target');pending.push(n)}
    if((ins.op>=0xac&&ins.op<=0xb1)||ins.op===0xbf)continue
    if(ins.op===0xaa||ins.op===0xab){target(ins.defaultTarget);for(const c of ins.cases)target(c.target);continue}
    if(ins.target!==undefined)target(ins.target)
    if(![0xa7,0xc8].includes(ins.op)&&index+1<seq.length)pending.push(index+1)
  }
  return { code:seq.filter((_,i)=>seen.has(i)),excluded:seq.filter((_,i)=>!seen.has(i)).map(i=>i.offset),exceptionHandlers:method.exceptionHandlers||[] }
}
module.exports={normalInstructions}
