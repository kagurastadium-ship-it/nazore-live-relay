import test from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {WebSocket} from 'ws';
import {createServer} from './server.mjs';
import {parseGrants} from './access.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

async function fixture(t){
 const upstreams=[];
 const app=createServer({origins:new Set(['https://nazore-web-orl.web.app']),grants:parseGrants('[{"ownerUid":"owner","tiktokIds":["broadcast"],"participantUids":["member"]}]'),verify:async({idToken,appCheckToken})=>{if(!['owner','member','other'].includes(idToken)||appCheckToken!=='attested')throw Error('invalid');return{uid:idToken,expiresAt:Date.now()+60000}},createConnection:id=>{const c=new EventEmitter();c.id=id;c.connect=async()=>{};c.disconnect=async()=>{};upstreams.push(c);return c}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+app.server.address().port,sockets=[];
 t.after(()=>{for(const s of sockets)s.terminate();app.close()});
 const connect=async(options={})=>{const s=new WebSocket(base.replace('http:','ws:')+'/live',options);sockets.push(s);await once(s,'open');return s};
 const authorize=async(s,uid='owner',extra={})=>{const reply=once(s,'message');s.send(JSON.stringify({type:'authorize',role:'owner',idToken:uid,appCheckToken:'attested',tiktokId:'broadcast',subscriptionId:'sub-'+uid,...extra}));return JSON.parse((await reply)[0])};
 return{base,app,connect,authorize,upstreams,sockets};
}
test('health discloses authentication requirement; HTTP cannot start or stop sessions',async t=>{
 const f=await fixture(t);assert.deepEqual(await fetch(f.base+'/health').then(r=>r.json()),{ok:true,protocol:2,authentication:'required'});assert.equal((await fetch(f.base+'/live',{method:'POST',body:'stop'})).status,405);assert.equal((await fetch(f.base+'/sessions')).status,404);assert.equal(f.upstreams.length,0);
});
test('real WebSocket rejects old protocol without starting an upstream',async t=>{
 const f=await fixture(t),s=await f.connect(),closed=once(s,'close');s.send(JSON.stringify({type:'subscribe',tiktokId:'broadcast',subscriptionId:'old'}));assert.equal((await closed)[0],1008);assert.equal(f.upstreams.length,0);
});
test('authorized WebSocket retains real subscribe/round/comment flow',async t=>{
 const f=await fixture(t),s=await f.connect({origin:'https://nazore-web-orl.web.app'});const auth=await f.authorize(s);assert.equal(auth.type,'authorized');assert.equal(f.upstreams.length,0);
 const status=once(s,'message');s.send(JSON.stringify({type:'subscribe',tiktokId:'broadcast',subscriptionId:'sub-owner',commentMode:'words'}));await status;
 await new Promise(r=>setImmediate(r));assert.equal(f.upstreams.length,1);
 const member=await f.connect();await f.authorize(member,'member',{role:'participant',sessionId:auth.sessionId});const joined=once(member,'message');member.send(JSON.stringify({type:'subscribe',tiktokId:'broadcast',subscriptionId:'sub-member',commentMode:'words'}));await joined;
 const ownerChat=nextChat(s),memberChat=nextChat(member);s.send(JSON.stringify({type:'round',subscriptionId:'sub-owner'}));await new Promise(r=>setImmediate(r));f.upstreams[0].emit('chat',{content:'メロン',msgId:'event',timestamp:Date.now()});assert.equal((await ownerChat).comment,'メロン');assert.equal((await memberChat).comment,'メロン');
 const denied=once(member,'close');member.send(JSON.stringify({type:'stop',subscriptionId:'sub-member'}));assert.equal((await denied)[0],1008);assert.equal(s.readyState,WebSocket.OPEN);
});
function nextChat(s){return new Promise((resolve,reject)=>{const timeout=setTimeout(()=>{s.off('message',handler);reject(Error('chat timeout'))},3000);const handler=b=>{const v=JSON.parse(b);if(v.type==='chat'){clearTimeout(timeout);s.off('message',handler);resolve(v)}};s.on('message',handler)})}
test('forbidden browser Origin and token-bearing URL fail before WebSocket authorization',async t=>{
 const f=await fixture(t);for(const [suffix,origin]of [['','https://unrelated.invalid'],['?token=not-allowed','https://nazore-web-orl.web.app']]){const s=new WebSocket(f.base.replace('http:','ws:')+'/live'+suffix,{origin});f.sockets.push(s);const [error]=await once(s,'error');assert.match(error.message,/403/)}assert.equal(f.upstreams.length,0);
});
test('authenticated UID alone cannot open an ungranted session over the network',async t=>{
 const f=await fixture(t),s=await f.connect(),closed=once(s,'close');s.send(JSON.stringify({type:'authorize',role:'owner',idToken:'other',appCheckToken:'attested',tiktokId:'broadcast',subscriptionId:'sub-other'}));assert.equal((await closed)[0],1008);assert.equal(f.upstreams.length,0);
});

test('startup fails closed without printing raw diagnostics or configuration',()=>{
 const entry=new URL('./server.mjs',import.meta.url);
 for(const debug of ['', '1']){const env={...process.env,NAZORE_LIVE_GRANTS_JSON:'invalid-private-fixture',DEBUG:debug,NODE_DEBUG:'',DEBUG_DESERIALIZE_XD:'',GOOGLE_SDK_NODE_LOGGING:'',GRPC_TRACE:''};const r=spawnSync(process.execPath,[fileURLToPath(entry)],{encoding:'utf8',env});assert.equal(r.status,1);assert.equal(r.stderr.trim(),'NAZORE_RELAY_FATAL');assert.equal(r.stdout.trim(),'');}
});

test('missing mounted Secret File refuses startup before listening without exposing its path',()=>{
 const env={...process.env,NAZORE_LIVE_GRANTS_JSON:'[{"ownerUid":"owner","tiktokIds":["broadcast"],"participantUids":[]}]',NAZORE_ALLOWED_ORIGINS:'https://nazore-web-orl.web.app',FIREBASE_PROJECT_ID:'nazore-web-orl',FIREBASE_APP_IDS:'approved-app',GOOGLE_APPLICATION_CREDENTIALS:fileURLToPath(new URL('./never-created-private-credential.json',import.meta.url)),DEBUG:'',NODE_DEBUG:'',DEBUG_DESERIALIZE_XD:'',GOOGLE_SDK_NODE_LOGGING:'',GRPC_TRACE:''};
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('./server.mjs',import.meta.url))],{encoding:'utf8',env});assert.equal(r.status,1);assert.equal(r.stderr.trim(),'NAZORE_RELAY_FATAL');assert.equal(r.stdout.trim(),'');
});
