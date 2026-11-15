// SPDX-License-Identifier: AGPL-3.0-only
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {randomUUID,randomBytes,createHmac} from 'node:crypto';
import {normalizeId} from './relay.mjs';

const validUid=value=>typeof value==='string'&&value.length>0&&value.length<=128&&!/[\s/\u0000-\u001f]/u.test(value);
export function parseGrants(text){
  let rows;try{rows=JSON.parse(text)}catch{throw Error('LIVE grants are required')}
  if(!Array.isArray(rows)||!rows.length||rows.length>128)throw Error('Invalid LIVE grants');
  const grants=new Map();
  for(const row of rows){
    if(!validUid(row?.ownerUid)||grants.has(row.ownerUid)||!Array.isArray(row.tiktokIds)||!row.tiktokIds.length||row.tiktokIds.length>16||!Array.isArray(row.participantUids)||row.participantUids.length>32||row.participantUids.some(uid=>!validUid(uid)))throw Error('Invalid LIVE grants');
    grants.set(row.ownerUid,{targets:new Set(row.tiktokIds.map(normalizeId)),participants:new Set(row.participantUids)});
  }
  return grants;
}

export async function firebaseVerifier({projectId,appIds,checkRevoked=true}){
  if(!/^[a-z][a-z0-9-]{4,29}$/.test(projectId||'')||!appIds?.size)throw Error('Firebase verification configuration required');
  if(!process.env.GOOGLE_APPLICATION_CREDENTIALS)throw Error('Server credential file required');
  // ADC reads lazily; fail before listening if the required mounted file is absent or invalid.
  const credential=JSON.parse(await readFile(process.env.GOOGLE_APPLICATION_CREDENTIALS,'utf8'));
  if(credential.type!=='service_account'||credential.project_id!==projectId||!credential.client_email||!credential.private_key)throw Error('Invalid dedicated server credential');
  if(process.env.FIREBASE_AUTH_EMULATOR_HOST||process.env.FIREBASE_APPCHECK_EMULATOR_HOST)throw Error('Emulator tokens are forbidden in the relay');
  const {initializeApp}=await import('firebase-admin/app');
  const {getAuth}=await import('firebase-admin/auth');
  const {getAppCheck}=await import('firebase-admin/app-check');
  const app=initializeApp({projectId},'nazore-relay-'+randomUUID());
  return credentialVerifier({auth:getAuth(app),appCheck:getAppCheck(app),appIds,checkRevoked});
}

export function credentialVerifier({auth,appCheck,appIds,checkRevoked=true}){
  return async({idToken,appCheckToken})=>{
    if(typeof idToken!=='string'||idToken.length>8192||typeof appCheckToken!=='string'||appCheckToken.length>8192)throw Error('unauthenticated');
    const [user,attestation]=await Promise.all([auth.verifyIdToken(idToken,checkRevoked),appCheck.verifyToken(appCheckToken)]);
    if(!appIds.has(attestation.appId))throw Error('unauthenticated');
    return {uid:user.uid,expiresAt:Math.min(user.exp,attestation.token.exp)*1000};
  };
}

// Tokens exist only inside the first WebSocket frame and verifier call, never URLs/logs.
export function createAccess({relay,verify,grants,now=Date.now,uuid=randomUUID,setTimer=setTimeout,clearTimer=clearTimeout,sessionMs=300000,reconnectMs=15000,maxClients=128,maxPending=32,maxPerUid=3,onDiagnostic=()=>{}}){
  const clients=new Set(),sessions=new Map(),owners=new Map(),uidCounts=new Map(),ipWindows=new Map();let closed=false;
  const timer=(fn,ms)=>{const id=setTimer(fn,ms);id?.unref?.();return id};
  const salt=randomBytes(32),purge=()=>{for(const[k,v]of ipWindows)if(now()-v.at>=60000)ipWindows.delete(k)};
  let sweep;const sweepRates=()=>{purge();sweep=timer(sweepRates,60000)};sweep=timer(sweepRates,60000);
  const rate=(value,limit)=>{const key=createHmac('sha256',salt).update(value).digest('hex'),at=now();let row=ipWindows.get(key);if(!row||at-row.at>=60000){purge();if(!ipWindows.has(key)&&ipWindows.size>=2048)return false;row={at,count:0};ipWindows.set(key,row)}return ++row.count<=limit};
  const closingSockets=new WeakSet();
  const closeSocket=(socket,code,reason)=>{
    if(closingSockets.has(socket))return;closingSockets.add(socket);onDiagnostic('LIVE_CLOSE_REQUESTED');
    let timeout;const finish=()=>{onDiagnostic('LIVE_SOCKET_CLOSED');if(timeout!==undefined)clearTimer(timeout)};socket.once('close',finish);
    try{socket.close(code,reason)}catch{socket.terminate?.()}
    if(socket.readyState!==3)timeout=timer(()=>{socket.removeListener('close',finish);onDiagnostic('LIVE_FORCE_TERMINATE');socket.terminate?.()},1000);
    else socket.removeListener('close',finish);
  };
  const closeClient=(client,code,reason)=>{dispose(client);closeSocket(client.socket,code,reason)};
  const endSession=(session,code=1008)=>{
    if(session.closed)return;session.closed=true;clearTimer(session.grace);sessions.delete(session.id);owners.delete(session.key);
    for(const client of [...session.clients])closeClient(client,code,'session ended');
  };
  const dispose=client=>{
    if(client.disposed)return;client.disposed=true;clearTimer(client.deadline);clearTimer(client.expiry);clients.delete(client);client.proxy?.emit('close');
    if(client.uid){const n=(uidCounts.get(client.uid)||1)-1;if(n)uidCounts.set(client.uid,n);else uidCounts.delete(client.uid)}
    const s=client.session;if(!s)return;s.clients.delete(client);s.owners.delete(client);
    if(!s.owners.size&&!s.closed&&!s.grace)s.grace=timer(()=>endSession(s,s.expiresAt<=now()?4001:1008),Math.min(reconnectMs,Math.max(1,s.expiresAt-now())));
  };
  function attach(socket,{ip='unknown'}={}){
    onDiagnostic('LIVE_ACCESS_ATTACHED');
    socket.on('error',()=>{});
    if(closed||clients.size>=maxClients||[...clients].filter(c=>!c.uid).length>=maxPending||!rate('connect:'+ip,60)){closeSocket(socket,1013,'capacity');return}
    const c={socket,uid:null,session:null,proxy:null,disposed:false,verifying:false,messages:0,window:now()};clients.add(c);
    const deny=()=>{onDiagnostic('LIVE_AUTH_DENIED');closeClient(c,1008,'not authorized')};
    c.deadline=timer(deny,10000);socket.on('close',()=>dispose(c));socket.on('error',()=>closeClient(c,1011,'transport error'));
    socket.on('message',async(bytes,binary=false)=>{
      try{
        if(c.disposed)return;onDiagnostic('LIVE_FRAME_RECEIVED');if(binary||bytes.length>20000){deny();return}
        const at=now();if(at-c.window>=10000){c.window=at;c.messages=0}if(++c.messages>24){closeClient(c,1013,'rate limit');return}
        let data;try{data=JSON.parse(String(bytes))}catch{deny();return}
        if(!c.uid){
          if(c.verifying||data?.type!=='authorize'||!rate('auth:'+ip,20)){deny();return}c.verifying=true;
          if(typeof data.idToken!=='string'||data.idToken.length>8192||typeof data.appCheckToken!=='string'||data.appCheckToken.length>8192||typeof data.subscriptionId!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(data.subscriptionId)){deny();return}
          const identity=await verify({idToken:data.idToken,appCheckToken:data.appCheckToken});
          if(c.disposed||socket.readyState!==1)return;
          if(!validUid(identity?.uid)||!Number.isFinite(identity.expiresAt)||identity.expiresAt<=now()||!rate('uid:'+identity.uid,30)||(uidCounts.get(identity.uid)||0)>=maxPerUid){deny();return}
          const target=normalizeId(data.tiktokId);let s,role;
          if(data.role==='owner'){
            const grant=grants.get(identity.uid);if(!grant?.targets.has(target)){deny();return}
            const key=identity.uid+'\0'+target;s=owners.get(key);
            if(s&&s.expiresAt<=now()){endSession(s,4001);s=null}
            if(!s){s={id:uuid(),key,owner:identity.uid,target,participants:new Set(grant.participants),clients:new Set(),owners:new Set(),expiresAt:Math.min(identity.expiresAt,now()+sessionMs),closed:false};sessions.set(s.id,s);owners.set(key,s)}
            role='owner';clearTimer(s.grace);s.grace=null;
          }else if(data.role==='participant'){
            s=sessions.get(data.sessionId);if(!s||s.closed||s.expiresAt<=now()||!s.owners.size||!s.participants.has(identity.uid)||s.target!==target){deny();return}role='participant';
          }else{deny();return}
          c.uid=identity.uid;c.role=role;c.session=s;c.subscriptionId=data.subscriptionId;c.expiresAt=Math.min(identity.expiresAt,s.expiresAt);s.clients.add(c);if(role==='owner')s.owners.add(c);uidCounts.set(c.uid,(uidCounts.get(c.uid)||0)+1);
          clearTimer(c.deadline);c.deadline=timer(deny,10000);c.expiry=timer(()=>{if(c.expiresAt>=s.expiresAt)endSession(s,4001);else closeClient(c,4001,'credentials expired')},Math.max(1,c.expiresAt-now()));
          const proxy=new EventEmitter();Object.defineProperties(proxy,{readyState:{get:()=>socket.readyState},bufferedAmount:{get:()=>socket.bufferedAmount}});proxy.send=payload=>{if(s.closed||s.expiresAt<=now()){endSession(s,4001);return}if(c.expiresAt<=now()){closeClient(c,4001,'credentials expired');return}socket.send(payload)};proxy.close=(code,reason)=>closeClient(c,code,reason);c.proxy=proxy;
          socket.send(JSON.stringify({type:'authorized',protocol:2,subscriptionId:c.subscriptionId,sessionId:s.id,role,expiresAt:c.expiresAt}));return;
        }
        const s=c.session;if(s.closed||s.expiresAt<=now()||c.expiresAt<=now()){closeClient(c,4001,'credentials expired');return}
        if(bytes.length>2048||data.subscriptionId!==c.subscriptionId){deny();return}
        if(data.type==='subscribe'){
          if(c.subscribed||normalizeId(data.tiktokId)!==s.target||data.commentMode!=='words'){deny();return}
          if(c.role==='participant'&&![...s.owners].some(o=>o.subscribed)){deny();return}
          c.subscribed=true;clearTimer(c.deadline);relay.attach(c.proxy);c.proxy.emit('message',Buffer.from(JSON.stringify({type:'subscribe',tiktokId:s.target,subscriptionId:c.subscriptionId,commentMode:'words'})));
        }else if(data.type==='round'&&c.subscribed)c.proxy.emit('message',Buffer.from(JSON.stringify({type:'round',subscriptionId:c.subscriptionId})));
        else if(data.type==='stop'&&c.role==='owner')endSession(s);
        else deny();
      }catch{deny()}
    });
  }
  return {attach,stats:()=>({clients:clients.size,sessions:sessions.size}),close(){closed=true;clearTimer(sweep);for(const s of [...sessions.values()])endSession(s);for(const c of [...clients])closeClient(c,1001,'shutdown');ipWindows.clear()}};
}
