'use strict'
// Template only. example:wire is not a claim that a server implements this protocol.
module.exports={id:'example-protocol',apiVersion:1,loaderProtocols:['forge'],minecraftVersions:['1.20.1'],
  matches:{channels:{'example:wire':'1'}},
  setup(ctx){ctx.registerChannel({id:'example:wire',version:'1',messages:[
    {name:'request',discriminator:0,direction:'serverbound',schema:{type:'struct',fields:[{name:'requestId',codec:{type:'int'}},{name:'label',codec:{type:'utf'}}]}},
    {name:'reply',discriminator:1,direction:'clientbound',schema:{type:'struct',fields:[{name:'requestId',codec:{type:'int'}},{name:'accepted',codec:{type:'boolean'}}]}}
  ]})}
}
