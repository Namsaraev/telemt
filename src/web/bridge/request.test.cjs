'use strict';
const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const vm=require('node:vm');
function client(enabled,fetch){
 const context=vm.createContext({fetch,AbortController,ArrayBuffer,Uint8Array,DataView,btoa,setTimeout,clearTimeout});
 vm.runInContext(readFileSync(__dirname+'/request.js','utf8'),context);
 return context.TelemtBridgeRequest.create({yandexCdnCompat:enabled,base:()=> 'https://cdn.example.com/relay/nested',closed:()=>false,
  retryMs:()=>5000,requestMs:()=>1000,longPollMs:()=>1000,batchLimit:()=>2097152,
  read:async()=>new Uint8Array(),cancel:()=>{},failure:(reason,message)=>new Error(message),reason:()=> 'network',retrying:()=>{}});
}
function decode(headers){
 let encoded='';for(let i=0;i<Number(headers['X-Telemt-CDN-Body-Count']||0);i++)encoded+=headers['X-Telemt-CDN-Body-'+i];
 return Buffer.from(encoded,'base64url');
}
for(const enabled of [undefined,false,true])for(const [path,method,payload] of [
 ['/api/v1/session','POST',true],['/api/v1/up','POST',true],['/api/v1/down','POST',false],['/api/v1/session','DELETE',false]]){
 test(`${enabled}: ${method} ${path}`,async()=>{
  const api=client(enabled),body=payload?Uint8Array.from({length:32768},(_,i)=>i):null;
  const logical=api.options(method,'test-token',body,{'X-Up-Seq':'7','X-Lane-ID':'2'},undefined,true);
  Object.freeze(logical.headers);Object.freeze(logical);
  const wire=api.wireOptions(path,logical),request=new Request('https://cdn.example.com/relay/nested'+path,wire);
  assert.equal(wire.method,enabled?'GET':method);
  assert.equal((await request.arrayBuffer()).byteLength,enabled?0:body?.length||0);
  assert.equal(wire.headers.Authorization,'Bearer test-token');
  assert.equal(wire.headers['X-Up-Seq'],'7');assert.equal(wire.headers['X-Lane-ID'],'2');
  assert.equal(wire.keepalive,true);assert.equal(wire.cache,'no-store');
  if(enabled){assert.deepEqual(decode(wire.headers),Buffer.from(body||[]));assert.equal(wire.headers['X-Telemt-CDN-Method'],method)}
  else assert.strictEqual(wire,logical);
  assert.equal(logical.method,method);assert.strictEqual(logical.body,body);
 });
}
test('retries preserve envelope and exact Base Path',async()=>{
 const calls=[],api=client(true,async(url,options)=>{calls.push({url,options});return {status:calls.length===1?503:204,headers:new Headers()}});
 await api.send('/api/v1/up',api.options('POST','token',Uint8Array.of(0,255,128),{'X-Up-Seq':'9'}),null,2);
 assert.equal(calls.length,2);
 for(const {url,options} of calls){assert.equal(url,'https://cdn.example.com/relay/nested/api/v1/up');assert.equal(options.method,'GET');assert.equal(options.body,null);assert.equal(options.headers['X-Up-Seq'],'9');assert.deepEqual(decode(options.headers),Buffer.from([0,255,128]))}
});
test('unrelated methods and paths are unchanged; size bound is enforced',()=>{
 const api=client(true);
 for(const [path,method] of [['/api/v1/ws','GET'],['/api/v1/diagnostic','POST'],['/other','POST'],['/api/v1/up','DELETE']]){
  const value=api.options(method,'token',null);assert.strictEqual(api.wireOptions(path,value),value);
 }
 for(const size of [0,32769])assert.throws(()=>api.wireOptions('/api/v1/up',api.options('POST','token',new Uint8Array(size))));
 const source=Uint8Array.of(55,0,255,66);
 assert.deepEqual(decode(api.wireOptions('/api/v1/up',api.options('POST','token',source.subarray(1,3))).headers),Buffer.from([0,255]));
});
test('DATA fragmentation preserves IDs and bytes and uses bounded upload batches',()=>{
 const size=1048576,data=new ArrayBuffer(size+8),view=new DataView(data);
 view.setUint8(0,2);view.setUint8(3,7);view.setUint32(4,size);
 new Uint8Array(data,8).set(Uint8Array.from({length:size},(_,i)=>i));
 const direct=client(false);assert.strictEqual(direct.prepareFrames(data),data);
 const fragmented=client(true).prepareFrames(data),parts=[];let offset=0;
 while(offset<fragmented.byteLength){const v=new DataView(fragmented,offset),length=v.getUint32(4);assert.equal(v.getUint8(0),2);assert.equal(v.getUint8(3),7);assert.ok(length<=16384);parts.push(Buffer.from(fragmented,offset+8,length));offset+=8+length}
 assert.deepEqual(Buffer.concat(parts),Buffer.from(data,8));
 const context=vm.createContext({ArrayBuffer,Uint8Array,DataView});vm.runInContext(readFileSync(__dirname+'/buffers.js','utf8'),context);
 const buffers=context.TelemtBridgeBuffers.create({limits:()=>({batchBytes:32768,queueBytes:4194304,queueItems:4096}),buffered:()=>0});
 const queue=[fragmented];assert.ok(buffers.reserve(fragmented,null));let total=0;
 while(queue.length){const lease=buffers.takeBatch(queue,null);assert.ok(lease.body.byteLength<=32768);total+=lease.total;buffers.settleBatch(lease)}
 assert.equal(total,fragmented.byteLength);buffers.assertEmpty();
});
test('runtime cleanup uses CDN mapping after close',()=>{
 const source=readFileSync(__dirname+'/runtime.js','utf8').match(/function deleteSession\(\)\{[\s\S]*?\n\}/)[0];
 for(const enabled of [false,true]){
  const api=client(enabled),calls=[],context=vm.createContext({cleanupToken:'cleanup',sessionToken:'session',closed:true,terminalFailure:'network',canonicalFailures:['network'],relayBase:'https://cdn.example.com/relay',requestClient:api,options:api.options,fetch:async(url,options)=>calls.push({url,options})});
  vm.runInContext(source+'\ndeleteSession();',context);assert.equal(calls.length,1);assert.equal(calls[0].options.method,enabled?'GET':'DELETE');assert.equal(calls[0].options.body,null);
 }
});
test('fragment expansion retains valid native frame-count boundary for lane dispatch',()=>{
 const context=vm.createContext({ArrayBuffer,Uint8Array,DataView});vm.runInContext(readFileSync(__dirname+'/buffers.js','utf8'),context);
 const buffers=context.TelemtBridgeBuffers.create({});
 const data=new ArrayBuffer(4095*9+32776),view=new DataView(data);let offset=0;
 for(let i=0;i<4096;i++){const size=i===4095?32768:1;view.setUint8(offset,2);view.setUint8(offset+3,7);view.setUint32(offset+4,size);offset+=8+size}
 assert.equal(buffers.splitFrames(data).length,4096);
 const prepared=client(true).prepareFrames(data);
 assert.equal(buffers.splitFrames(prepared,262144).length,4097);
 assert.throws(()=>buffers.splitFrames(prepared));
});
test('base64url chunk boundaries round-trip all byte values',()=>{
 const api=client(true);
 for(const size of [1,2,3,4607,4608,4609,32767,32768]){
  const body=Uint8Array.from({length:size},(_,i)=>i),wire=api.wireOptions('/api/v1/up',api.options('POST','token',body));
  assert.deepEqual(decode(wire.headers),Buffer.from(body));
  const count=Number(wire.headers['X-Telemt-CDN-Body-Count']);
  for(let i=0;i<count;i++){const value=wire.headers['X-Telemt-CDN-Body-'+i];assert.match(value,/^[A-Za-z0-9_-]+$/);assert.ok(value.length<=6144);if(i<count-1)assert.equal(value.length,6144)}
 }
});
