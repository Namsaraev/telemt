(()=>{'use strict';
function create(settings){
 const pause=(milliseconds,signal)=>new Promise((resolve,reject)=>{
  if(signal&&signal.aborted){reject(new Error('request aborted'));return}
  const timer=setTimeout(done,milliseconds);function done(){if(signal)signal.removeEventListener('abort',abort);resolve()}
  function abort(){clearTimeout(timer);signal.removeEventListener('abort',abort);reject(new Error('request aborted'))}
  if(signal)signal.addEventListener('abort',abort,{once:true});
 });
 // Freeze the wire envelope once so retries retain the same payload and sequence.
 function wireOptions(path,value){
  if(!settings.yandexCdnCompat)return value;
  const payload=value.method==='POST'&&(path==='/api/v1/session'||path==='/api/v1/up');
  if(!payload&&!(value.method==='POST'&&path==='/api/v1/down')&&!(value.method==='DELETE'&&path==='/api/v1/session'))return value;
  const headers=Object.assign({},value.headers,{'X-Telemt-CDN-Method':value.method});
  if(payload){
   const body=value.body,bytes=ArrayBuffer.isView(body)?new Uint8Array(body.buffer,body.byteOffset,body.byteLength):new Uint8Array(body);
   if(!bytes.length||bytes.length>32768)throw new Error('invalid CDN payload size');
   let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
   const encoded=btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
   const count=Math.ceil(encoded.length/6144);headers['X-Telemt-CDN-Body-Count']=String(count);
   for(let i=0;i<count;i++)headers['X-Telemt-CDN-Body-'+i]=encoded.slice(i*6144,(i+1)*6144);
  }else if(value.body&&value.body.byteLength)throw new Error('unexpected CDN payload');
  return Object.assign({},value,{method:'GET',body:null,headers});
 }
 // DATA is a byte stream: split large frames before queue reservation, preserving stream IDs.
 function prepareFrames(data){
  if(!settings.yandexCdnCompat||!data)return data;
  const view=new DataView(data),parts=[];let offset=0,total=0;
  while(offset<data.byteLength){
   if(data.byteLength-offset<8)throw new Error('invalid frame batch');
   const size=view.getUint32(offset+4),end=offset+8+size,type=view.getUint8(offset);
   if(size>1048576||end>data.byteLength)throw new Error('invalid frame');
   if(type!==2&&size+8>32768)throw new Error('oversized CDN control frame');
   if(type===2&&size>16384){
    for(let start=0;start<size;start+=16384){
     const length=Math.min(16384,size-start),part=new Uint8Array(8+length);
     part.set(new Uint8Array(data,offset,4));new DataView(part.buffer).setUint32(4,length);
     part.set(new Uint8Array(data,offset+8+start,length),8);parts.push(part);total+=part.length;
    }
   }else{const part=new Uint8Array(data,offset,end-offset);parts.push(part);total+=part.length}
   offset=end;
  }
  if(total===data.byteLength)return data;
  const joined=new Uint8Array(total);offset=0;
  for(const part of parts){joined.set(part,offset);offset+=part.length}
  return joined.buffer;
 }
 const options=(method,token,body,headers,signal,keepalive)=>({
  method,body,signal,keepalive:!!keepalive,mode:'same-origin',credentials:'omit',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer',
  headers:Object.assign(token?{Authorization:'Bearer '+token}:{},body?{'Content-Type':'application/octet-stream'}:{},headers||{})
 });
 function retryAfterMs(response){
  const header=response.headers.get('Retry-After');
  if(!header)return 0;
  const seconds=Number(header);
  if(Number.isFinite(seconds)&&seconds>=0)return Math.min(seconds*1000,30000);
  const when=Date.parse(header);
  if(Number.isFinite(when)){const delta=when-Date.now();return delta>0?Math.min(delta,30000):0}
  return 0;
 }
 function retryableStatus(status){return status===408||status===429||status===502||status===503||status===504}
 function responsePolicy(path,status){
  if(path==='/api/v1/session'&&status===200)return {limit:8,exact:true,reason:'protocol'};
  if(path==='/api/v1/down'&&status===200)return {limit:settings.batchLimit(),exact:false,reason:'protocol'};
  if(status===204&&(path==='/api/v1/up'||path==='/api/v1/down'))return {limit:0,exact:true,reason:'protocol'};
  return {limit:0,exact:true,reason:'http'};
 }
 async function send(path,frozenOptions,remainingBudget,maxAttempts){
  frozenOptions=wireOptions(path,frozenOptions);
  let delay=250,attempt=0,lastReason='network';maxAttempts=maxAttempts||9;
  const initialBudget=remainingBudget?Math.min(settings.retryMs(),remainingBudget()):settings.retryMs();
  const deadline=Date.now()+Math.max(0,initialBudget),external=frozenOptions.signal;
  const attemptLimit=path==='/api/v1/down'?settings.longPollMs()+settings.requestMs():settings.requestMs();
  while(attempt<maxAttempts){
   if(settings.closed()||(external&&external.aborted))throw new Error('request aborted');
   const remaining=Math.min(deadline-Date.now(),remainingBudget?remainingBudget():Infinity);if(remaining<=0)break;attempt++;
   const controller=new AbortController(),abort=()=>controller.abort();let timedOut=false;
   if(external)external.addEventListener('abort',abort,{once:true});
   const requestOptions=Object.assign({},frozenOptions,{signal:controller.signal});
   const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.max(1,Math.min(attemptLimit,remaining)));
   let response=null,wait=0;
   try{
    const fetched=await fetch(settings.base()+path,requestOptions);
    if(retryableStatus(fetched.status)){
     lastReason='http';wait=retryAfterMs(fetched);settings.cancel(fetched);
    }else{
     const policy=responsePolicy(path,fetched.status);let body;
     try{body=await settings.read(fetched,policy.limit,policy.exact,controller.signal)}
     catch(error){
      controller.abort();
      if(external&&external.aborted)throw error;
      if(timedOut)throw settings.failure('timeout','response deadline exceeded');
      throw settings.failure(policy.reason,error&&error.message);
     }
     response={status:fetched.status,headers:fetched.headers,body};return response;
    }
   }catch(error){
    controller.abort();
    if(settings.closed()||(external&&external.aborted))throw error;
    if(timedOut)lastReason='timeout';
    if(settings.reason(error,'')==='protocol')throw error;
   }finally{clearTimeout(timer);if(external)external.removeEventListener('abort',abort)}
   const after=Math.min(deadline-Date.now(),remainingBudget?remainingBudget():Infinity);if(attempt>=maxAttempts||after<=0)break;
   settings.retrying();
   const backoff=wait||delay+Math.floor(Math.random()*Math.max(1,delay/4));
   await pause(Math.min(backoff,after),external);delay=Math.min(delay*2,2000);
  }
  throw settings.failure(lastReason,'carrier retry limit reached');
 }
 return Object.freeze({options,wireOptions,prepareFrames,pause,send});
}
globalThis.TelemtBridgeRequest=Object.freeze({create});
})();
