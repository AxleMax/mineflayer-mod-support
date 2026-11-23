'use strict'
const { instructions } = require('./classfile')
const OWNER='net/minecraft/world/inventory/RecipeBookType'
const VANILLA=['CRAFTING','FURNACE','BLAST_FURNACE','SMOKER']
// Forge extends this enum through create(String). Wire settings use values()
// order and two booleans per value. We need the count, never guess field widths.
function discoverRecipeBookTypes (classes) {
  const extensions=[];const unresolved=[]
  for(const cls of classes.values())for(const method of cls.methods){
    const seq=instructions(cls,method)
    for(let i=0;i<seq.length;i++){
      const ins=seq[i],m=ins.member
      if(ins.op!==0xb8||m?.owner!==OWNER||m.name!=='create'||m.descriptor!=='(Ljava/lang/String;)L'+OWNER+';')continue
      const evidence={owner:cls.thisClass,method:method.name,descriptor:method.descriptor,offset:ins.offset}
      const name=seq[i-1]?.literal
      const branched=seq.some(x=>(x.op>=0x99&&x.op<=0xab)||[0xc6,0xc7,0xc8,0xc9].includes(x.op))
      if(method.name!=='<clinit>'||branched||typeof name!=='string'||!name.length){unresolved.push({...evidence,reason:'recipe_book_enum_creation_not_unconditional_literal_clinit'});continue}
      extensions.push({...evidence,name})
    }
  }
  return {vanillaTypes:VANILLA,extensions,unresolved}
}
module.exports={discoverRecipeBookTypes,VANILLA}
