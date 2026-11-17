import test from 'node:test';
import assert from 'node:assert/strict';
import {upstreamFailure,upstreamFailureLog,createRelay} from './relay.mjs';
import {EventEmitter} from 'node:events';
const now=1800000000000,max=7*24*60*60*1000,secret='PRIVATE_TOKEN_UID_URL_HEADER_MESSAGE';
class SignatureRateLimitError extends Error {
 constructor(retryAfter,resetTime){super('Too many requests '+secret);this.name='SignatureRateLimitError';this.retryAfter=retryAfter;this.resetTime=resetTime;this.requestId=secret;this.headers={token:secret};}
}
test('installed SDK 2.5.0 retry headers are converted to bounded milliseconds',async()=>{
 const {SignatureRateLimitError:SDKError}=await import('tiktok-live-connector');
 const error=new SDKError(secret,'Retry later',{headers:{'retry-after':'31','x-ratelimit-reset':String((now+60000)/1000),'x-log-id':secret,'x-agent-id':secret}});
 assert.deepEqual(upstreamFailure(error,now),{kind:'rate-limit',type:'SignatureRateLimitError',source:'signature-service',retryAfterMs:31000,resetTimeMs:now+60000});
});
test('SDK-shaped nested signature error preserves millisecond units without raw fields',()=>{
 const details=upstreamFailure({exception:new SignatureRateLimitError(30001,now+60000)},now);
 assert.deepEqual(details,{kind:'rate-limit',type:'SignatureRateLimitError',source:'signature-service',retryAfterMs:30001,resetTimeMs:now+60000});
 assert.deepEqual(upstreamFailureLog(details,now),['LIVE_UPSTREAM_FAILURE_RATE_LIMIT',{source:'signature-service',retryAfterMs:30001,resetTimeMs:now+60000}]);
 assert.ok(!JSON.stringify(details).includes(secret));
});
for(const value of [undefined,null,'1200',-1,NaN,Infinity,-Infinity,{},max+1])test('invalid retry duration omitted: '+String(value),()=>{
 const details=upstreamFailure(new SignatureRateLimitError(value,undefined),now);
 assert.ok(!('retryAfterMs' in details));assert.ok(!('retryAfterMs' in upstreamFailureLog({...details,retryAfterMs:value},now)[1]));
});
for(const value of [undefined,null,'1800000001000',-1,NaN,Infinity,now-1,now+max+1])test('invalid reset omitted: '+String(value),()=>{
 const details=upstreamFailure(new SignatureRateLimitError(0,value),now);
 assert.ok(!('resetTimeMs' in details));assert.ok(!('resetTimeMs' in upstreamFailureLog({...details,resetTimeMs:value},now)[1]));
});
test('inclusive bounds and fractions never shorten a wait',()=>{
 for(const value of [0,max]){const d=upstreamFailure(new SignatureRateLimitError(value,now+value),now);assert.equal(d.retryAfterMs,value);assert.equal(d.resetTimeMs,now+value);}
 const d=upstreamFailure(new SignatureRateLimitError(1.1,now+1.1),now);assert.equal(d.retryAfterMs,2);assert.equal(d.resetTimeMs,now+2);
});
test('unknown names and fabricated numeric fields are not attributed to a service',()=>{
 const d=upstreamFailure(Object.assign(Error('rate limit '+secret),{name:secret,retryAfter:2000,resetTime:now+2000}),now);
 assert.deepEqual(d,{kind:'rate-limit',type:'Error',source:'unknown'});
 assert.deepEqual(upstreamFailureLog({...d,source:'signature-service',retryAfterMs:2000},now)[1],{source:'unknown'});
});
test('numeric getters never run; extra objects never reach logging',()=>{
 const e=new SignatureRateLimitError(1,now+1);
 for(const key of ['retryAfter','resetTime'])Object.defineProperty(e,key,{get(){throw Error(secret)}});
 const d=upstreamFailure(e,now);assert.deepEqual(d,{kind:'rate-limit',type:'SignatureRateLimitError',source:'signature-service'});
 const output=upstreamFailureLog({...d,token:secret,headers:{raw:secret}},now);assert.deepEqual(output,['LIVE_UPSTREAM_FAILURE_RATE_LIMIT',{source:'signature-service'}]);
});
test('failed upstream emits safe diagnostic once, preserves terminal status and never reconnects',async()=>{
 const diagnostics=[],frames=[];let connects=0,disconnects=0;
 const upstream=new EventEmitter();upstream.connect=async()=>{connects++;throw new SignatureRateLimitError(5000,Date.now()+60000)};upstream.disconnect=async()=>{disconnects++};
 const relay=createRelay({createConnection:()=>upstream,onDiagnostic:d=>diagnostics.push(d)});
 const socket=new EventEmitter();socket.readyState=1;socket.bufferedAmount=0;socket.send=text=>frames.push(JSON.parse(text));socket.close=()=>{};
 try{
  relay.attach(socket);socket.emit('message',Buffer.from(JSON.stringify({type:'subscribe',tiktokId:'fixture',subscriptionId:'fixture',commentMode:'words'})));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(connects,1);assert.equal(disconnects,1);assert.equal(diagnostics.length,1);assert.equal(diagnostics[0].source,'signature-service');assert.equal(diagnostics[0].retryAfterMs,5000);
  assert.equal(frames.at(-1).terminal,true);assert.ok(!JSON.stringify(frames).includes(secret));assert.ok(!JSON.stringify(frames).includes('retryAfter'));assert.ok(!JSON.stringify(diagnostics).includes(secret));
  await new Promise(resolve=>setImmediate(resolve));assert.equal(connects,1);
 }finally{relay.close()}
});
