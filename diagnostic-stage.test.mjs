import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {credentialVerifier,createAccess} from './access.mjs';
for(const [mode,event] of [['id','LIVE_REJECT_ID_TOKEN'],['appcheck','LIVE_REJECT_APP_CHECK'],['appid','LIVE_REJECT_APP_ID'],['owner','LIVE_REJECT_OWNER_GRANT'],['target','LIVE_REJECT_TARGET_GRANT'],['unknown','LIVE_REJECT_UNCLASSIFIED'],['success',null]])test('private stage '+mode,async()=>{
 const sensitive='DO_NOT_LOG_TOKEN_UID_RAW_ERROR',events=[],frames=[];let upstream=0;
 const auth={async verifyIdToken(){if(mode==='id')throw Error(sensitive);return {uid:sensitive,exp:Date.now()/1000+120}}};
 const appCheck={async verifyToken(){if(mode==='appcheck')throw Error(sensitive);return {appId:mode==='appid'?'other':'app',token:{exp:Date.now()/1000+120}}}};
 const verifier=credentialVerifier({auth,appCheck,appIds:new Set(['app'])});
 const grants=new Map(mode==='owner'?[]:[[sensitive,{targets:new Set([mode==='target'?'other':'broadcast']),participants:new Set()}]]);
 const access=createAccess({relay:{attach(){upstream++}},verify:mode==='unknown'?async()=>{throw Object.assign(Error(sensitive),{diagnosticCode:sensitive})}:verifier,grants,onDiagnostic:e=>events.push(e)});
 class Socket extends EventEmitter{readyState=1;send(x){frames.push(JSON.parse(x))}close(code,reason){this.code=code;this.reason=reason;this.readyState=3;this.emit('close')}}
 const socket=new Socket();access.attach(socket);socket.emit('message',Buffer.from(JSON.stringify({type:'authorize',role:'owner',tiktokId:'broadcast',subscriptionId:'probe',idToken:sensitive,appCheckToken:sensitive})));
 await new Promise(r=>setImmediate(r));
 if(event){assert.ok(events.includes(event));assert.equal(socket.code,1008);assert.equal(socket.reason,'not authorized');assert.equal(frames.length,0)}else assert.equal(frames[0].type,'authorized');
 assert.equal(upstream,0);assert.ok(!JSON.stringify(events).includes(sensitive));assert.ok(!JSON.stringify(frames).includes(sensitive));access.close();
});
