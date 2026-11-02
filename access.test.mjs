import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createAccess,parseGrants} from './access.mjs';
import {createRelay} from './relay.mjs';

const settle=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
function fixture(options={}){
 let time=1793600000000,serial=0,verifications=0;const timers=new Map(),upstreams=[];
 const setTimer=(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:time+ms});return id},clearTimer=id=>timers.delete(id);
 const relay=createRelay({now:()=>time,setTimer,clearTimer,createConnection:id=>{const room=new EventEmitter();room.id=id;room.connect=async()=>{};room.disconnect=async()=>{room.disconnected=true};upstreams.push(room);return room}});
 const verify=async({idToken,appCheckToken})=>{verifications++;if(appCheckToken!=='attested'||!['owner','member','other','expired','second'].includes(idToken))throw Error('invalid credentials');return {uid:idToken==='expired'?'owner':idToken,expiresAt:idToken==='expired'?time-1:time+3600000}};
 const grants=parseGrants(JSON.stringify([{ownerUid:'owner',tiktokIds:['broadcast'],participantUids:['member']},{ownerUid:'second',tiktokIds:['broadcast'],participantUids:[]}]));
 const access=createAccess({relay,verify,grants,now:()=>time,setTimer,clearTimer,...options});
 class Socket extends EventEmitter{readyState=1;bufferedAmount=0;sent=[];send(x){this.sent.push(JSON.parse(x))}close(code){if(this.readyState===3)return;this.code=code;this.readyState=3;this.emit('close')}async frame(data,binary=false){this.emit('message',Buffer.from(typeof data==='string'?data:JSON.stringify(data)),binary);await settle()}}
 const socket=(ip='one')=>{const s=new Socket();access.attach(s,{ip});return s};
 async function authorize(uid='owner',extra={},ip='one'){const s=socket(ip);await s.frame({type:'authorize',role:'owner',tiktokId:'broadcast',subscriptionId:'sub-'+uid,idToken:uid,appCheckToken:'attested',...extra});return s}
 const subscribe=s=>s.frame({type:'subscribe',tiktokId:'broadcast',subscriptionId:s.sent[0]?.subscriptionId,commentMode:'words'});
 const tick=async ms=>{time+=ms;for(let i=0;i<200;i++){const due=[...timers].filter(([,t])=>t.at<=time);if(!due.length)break;timers.delete(due[0][0]);due[0][1].fn();await settle()}};
 return {access,relay,upstreams,socket,authorize,subscribe,tick,settle,get verifications(){return verifications},time:()=>time};
}

test('grants are mandatory, bounded and validated without permissive defaults',()=>{
 for(const value of [undefined,'{}','[]','[{"ownerUid":"owner","tiktokIds":["bad/id"],"participantUids":[]}]'])assert.throws(()=>parseGrants(value));
 assert.equal(parseGrants('[{"ownerUid":"__proto__","tiktokIds":["broadcast"],"participantUids":[]}]').size,1);
});
test('legacy unauthenticated subscribe and missing authentication time out without TikTok access',async()=>{
 const f=fixture(),s=f.socket();await s.frame({type:'subscribe',tiktokId:'broadcast'});assert.equal(s.code,1008);assert.equal(f.upstreams.length,0);
 const idle=f.socket();await f.tick(10000);assert.equal(idle.code,1008);assert.equal(f.access.stats().clients,0);f.access.close();
});
test('invalid, expired and unattested credentials are rejected',async()=>{
 const f=fixture();for(const [token,extra]of [['invalid',{}],['expired',{}],['owner',{appCheckToken:'invalid'}]]){const s=await f.authorize(token,extra);assert.equal(s.code,1008)}assert.equal(f.upstreams.length,0);assert.equal(f.access.stats().sessions,0);f.access.close();
});
test('authenticated owner can create only an allowed broadcaster session, then subscribe',async()=>{
 const f=fixture();const denied=await f.authorize('other');assert.equal(denied.code,1008);const wrong=await f.authorize('owner',{tiktokId:'someone_else'});assert.equal(wrong.code,1008);
 const s=await f.authorize();assert.equal(s.sent[0].type,'authorized');assert.equal(f.upstreams.length,0);await f.subscribe(s);assert.equal(f.upstreams.length,1);assert.ok(s.sent.some(m=>m.state?.startsWith('LIVE接続済み')));assert.ok(!JSON.stringify(s.sent).includes('attested'));f.access.close();
});
test('only explicitly allowed participants can join the exact session',async()=>{
 const f=fixture(),owner=await f.authorize();await f.subscribe(owner);const sessionId=owner.sent[0].sessionId;
 for(const [uid,id]of [['other',sessionId],['member','foreign-session']]){const s=await f.authorize(uid,{role:'participant',sessionId:id});assert.equal(s.code,1008)}
 const member=await f.authorize('member',{role:'participant',sessionId});await f.subscribe(member);f.upstreams[0].emit('chat',{content:'メロン',msgId:'one',timestamp:f.time()});assert.equal(member.sent.at(-1).comment,'メロン');assert.equal(owner.sent.at(-1).comment,'メロン');f.access.close();
});
test('an allowed owner cannot use another owner session as a participant',async()=>{
 const f=fixture(),a=await f.authorize();await f.subscribe(a);const b=await f.authorize('second',{role:'participant',sessionId:a.sent[0].sessionId});assert.equal(b.code,1008);
 const own=await f.authorize('second');assert.notEqual(own.sent[0].sessionId,a.sent[0].sessionId);f.access.close();
});
test('participants cannot stop a session or change its broadcaster',async()=>{
 const f=fixture(),o=await f.authorize();await f.subscribe(o);const m=await f.authorize('member',{role:'participant',sessionId:o.sent[0].sessionId});await f.subscribe(m);await m.frame({type:'stop',subscriptionId:'sub-member'});assert.equal(m.code,1008);assert.equal(o.readyState,1);assert.equal(f.access.stats().sessions,1);
 const m2=await f.authorize('member',{role:'participant',sessionId:o.sent[0].sessionId});await m2.frame({type:'subscribe',tiktokId:'foreign',subscriptionId:'sub-member',commentMode:'words'});assert.equal(m2.code,1008);f.access.close();
});
test('owner stop closes every participant and releases the upstream and session',async()=>{
 const f=fixture(),o=await f.authorize();await f.subscribe(o);const m=await f.authorize('member',{role:'participant',sessionId:o.sent[0].sessionId});await f.subscribe(m);await o.frame({type:'stop',subscriptionId:'sub-owner'});await settle();assert.equal(o.code,1008);assert.equal(m.code,1008);assert.equal(f.access.stats().sessions,0);assert.equal(f.relay.stats().rooms,0);f.access.close();
});
test('expiry closes authenticated sockets and never leaves a usable session',async()=>{
 const f=fixture(),o=await f.authorize();await f.subscribe(o);await f.tick(300000);assert.equal(o.code,4001);assert.deepEqual(f.access.stats(),{clients:0,sessions:0});assert.equal(f.relay.stats().rooms,0);f.access.close();
});
test('owner reconnect resumes its session within bounded grace; absent owner cleans participants',async()=>{
 const f=fixture(),o=await f.authorize();await f.subscribe(o);const id=o.sent[0].sessionId,m=await f.authorize('member',{role:'participant',sessionId:id});await f.subscribe(m);o.close(1000);await f.tick(5000);const replacement=await f.authorize();assert.equal(replacement.sent[0].sessionId,id);await f.subscribe(replacement);await f.tick(10001);assert.equal(m.readyState,1);replacement.close(1000);await f.tick(15000);assert.equal(m.code,1008);assert.equal(f.access.stats().sessions,0);f.access.close();
});
test('failed authentication is rate limited before expensive verifier calls',async()=>{
 const f=fixture();for(let i=0;i<25;i++)await f.authorize('invalid');assert.equal(f.verifications,20);assert.deepEqual(f.access.stats(),{clients:0,sessions:0});f.access.close();
});
test('per UID connections and unauthenticated capacity are bounded',async()=>{
 const f=fixture();for(let i=0;i<3;i++)assert.equal((await f.authorize()).readyState,1);assert.equal((await f.authorize()).code,1008);f.access.close();
 const g=fixture({maxPending:2});g.socket('a');g.socket('b');assert.equal(g.socket('c').code,1013);g.access.close();
});
test('foreign round IDs, binary frames and oversized frames cannot reach the relay',async()=>{
 const f=fixture(),o=await f.authorize();await f.subscribe(o);await o.frame({type:'round',subscriptionId:'someone_else'});assert.equal(o.code,1008);
 const binary=f.socket();await binary.frame('binary',true);assert.equal(binary.code,1008);const big=f.socket();await big.frame('x'.repeat(20001));assert.equal(big.code,1008);f.access.close();
});
test('a disconnected socket cannot finish delayed authorization or create an orphan session',async()=>{
 let resolve;const f=fixture({verify:()=>new Promise(r=>{resolve=r})}),s=f.socket();s.emit('message',Buffer.from(JSON.stringify({type:'authorize',role:'owner',tiktokId:'broadcast',subscriptionId:'sub',idToken:'owner',appCheckToken:'attested'})));s.close(1000);resolve({uid:'owner',expiresAt:999999});await settle();assert.deepEqual(f.access.stats(),{clients:0,sessions:0});f.access.close();
});

test('authenticated frame floods are bounded and cleaned up',async()=>{
 const f=fixture(),s=await f.authorize();await f.subscribe(s);for(let i=0;i<30&&s.readyState===1;i++)await s.frame({type:'round',subscriptionId:'sub-owner'});assert.equal(s.code,1013);assert.equal(f.access.stats().clients,0);await f.tick(15000);assert.equal(f.access.stats().sessions,0);f.access.close();
});
