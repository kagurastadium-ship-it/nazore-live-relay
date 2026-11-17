import {randomUUID} from 'node:crypto';
import Answers from './answer-comments.cjs';
export function normalizeId(value){const id=String(value||'').trim().replace(/^[@��]/,'').toLowerCase();if(!/^[a-z0-9._]{2,24}$/.test(id))throw Error('invalid-id');return id}
export function eventTime(raw,now=Date.now()){const value=raw?.common?.createTime??raw?.createTime??raw?.timestamp;if(value==null)return now;const n=Number(value);return Number.isFinite(n)&&n>0?(n<1e12?n*1000:n):null}
const MAX_RETRY_MS=7*24*60*60*1000;
const ownValue=(object,key)=>object&&(typeof object==='object'||typeof object==='function')?Object.getOwnPropertyDescriptor(object,key)?.value:undefined;
const boundedNumber=(value,min,max)=>typeof value==='number'&&Number.isFinite(value)&&value>=min&&value<=max?Math.ceil(value):undefined;
export function upstreamFailure(error,now=Date.now()){
 const e=error?.exception||error,message=String(e?.message||'');
 const kind=/isn.t online|not online|offline/i.test(message)?'offline':/rate.?limit|too many requests/i.test(message)?'rate-limit':/sign|api.?key|unauthori[sz]ed/i.test(message)?'signing':/timeout|timed out/i.test(message)?'timeout':'connection';
 // Never return arbitrary exception names, messages, headers, IDs or URLs.
 const signature=ownValue(e,'name')==='SignatureRateLimitError'||e?.constructor?.name==='SignatureRateLimitError';
 const details={kind,type:signature?'SignatureRateLimitError':'Error',source:signature?'signature-service':'unknown'};
 if(signature){
  const retryAfterMs=boundedNumber(ownValue(e,'retryAfter'),0,MAX_RETRY_MS);
  const resetTimeMs=boundedNumber(ownValue(e,'resetTime'),now,now+MAX_RETRY_MS);
  if(retryAfterMs!==undefined)details.retryAfterMs=retryAfterMs;
  if(resetTimeMs!==undefined)details.resetTimeMs=resetTimeMs;
 }
 return details;
}
export function upstreamFailureLog(details,now=Date.now()){
 const kind=['offline','rate-limit','signing','timeout','connection'].includes(details?.kind)?details.kind:'connection';
 const signature=details?.type==='SignatureRateLimitError'&&details?.source==='signature-service';
 const safe={source:signature?'signature-service':'unknown'};
 if(signature){
  const retryAfterMs=boundedNumber(ownValue(details,'retryAfterMs'),0,MAX_RETRY_MS);
  const resetTimeMs=boundedNumber(ownValue(details,'resetTimeMs'),now,now+MAX_RETRY_MS);
  if(retryAfterMs!==undefined)safe.retryAfterMs=retryAfterMs;
  if(resetTimeMs!==undefined)safe.resetTimeMs=resetTimeMs;
 }
 return ['LIVE_UPSTREAM_FAILURE_'+kind.toUpperCase().replace('-','_'),safe];
}
// Room connections are shared only for the same ID. No usernames, avatars or chat history are stored.
export function createRelay({createConnection,now=Date.now,timeoutMs=20000,maxRooms=32,maxClients=128,maxStartsPerMinute=30,onDiagnostic=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}={}){
 const rooms=new Map(),clients=new Set();let stopped=false,startWindow=now(),starts=0;
 const send=(client,payload)=>{if(client.socket.readyState!==1)return;if(client.socket.bufferedAmount>65536){client.socket.close(1013,'slow client');return}client.socket.send(JSON.stringify({...payload,subscriptionId:client.subscriptionId}))};
 const status=(client,state,extra={})=>send(client,{type:'status',state,...extra});
 const release=(client)=>{const room=client.room;client.room=null;if(!room)return;room.clients.delete(client);if(room.clients.size)return;room.closed=true;clearTimer(room.timer);if(rooms.get(room.id)===room)rooms.delete(room.id);Promise.resolve().then(()=>room.connection.disconnect()).catch(()=>{})};
 const end=(room,state)=>{if(room.closed)return;room.closed=true;clearTimer(room.timer);if(rooms.get(room.id)===room)rooms.delete(room.id);for(const c of room.clients){c.room=null;status(c,state,{terminal:true})}room.clients.clear();Promise.resolve().then(()=>room.connection.disconnect()).catch(()=>{})};
 const failure=(room,error)=>{if(room.closed)return;const diagnostic=upstreamFailure(error);try{onDiagnostic(diagnostic)}catch{}end(room,diagnostic.kind==='offline'?'�w�肵���z�M�҂͌��ݔz�M���ł͂���܂���B�z�M�J�n��ɐڑ����Ă�������':'LIVE�ɐڑ��ł��܂���B�z�M��Ԃ��m�F���čĐڑ����Ă�������')};
 const subscribe=(client,payload)=>{
  let id;try{id=normalizeId(payload.tiktokId)}catch{status(client,'TikTok ID���m�F���Ă�������',{terminal:true});return}
  if(payload.commentMode!==undefined&&!['kanji','words'].includes(payload.commentMode)){status(client,'Invalid comment mode',{terminal:true});return}
   if(client.subscriptions++>=8){status(client,'�ڑ���̕ύX���������܂��B�ڑ��������Ă�������',{terminal:true});return}
  release(client);client.subscriptionId=String(payload.subscriptionId||randomUUID()).slice(0,80);client.joinedAt=now();client.roundStartedAt=client.joinedAt;client.commentMode=payload.commentMode==='words'?'words':'kanji';
  let room=rooms.get(id);
  if(!room){
   if(rooms.size>=maxRooms){status(client,'LIVE�ڑ������ݍ����Ă��܂�',{terminal:true});return}
   if(now()-startWindow>=60000){startWindow=now();starts=0}if(starts>=maxStartsPerMinute){status(client,'�ڑ��v�������ݍ����Ă��܂��B1����ɐڑ��������Ă�������',{terminal:true});return}starts++;
   let connection;try{connection=createConnection(id)}catch{status(client,'LIVE�ڑ����J�n�ł��܂���',{terminal:true});return}
   room={id,connection,clients:new Set(),closed:false,ready:false,seen:new Set(),startedAt:now(),timer:null};rooms.set(id,room);
   connection.on('error',error=>failure(room,error));
   connection.on('disconnected',()=>end(room,'LIVE����ؒf����܂����B�Đڑ����Ă�������'));
   connection.on('streamEnd',()=>end(room,'LIVE�z�M���I�����܂���'));
   connection.on('chat',raw=>{
    if(room.closed||!room.ready)return;
    const comment=String(raw?.content??raw?.comment??'').trim();if(!comment||Array.from(comment).length>80||/[\u0000-\u001F\u007F]/u.test(comment))return;
    const timestamp=eventTime(raw,now());if(timestamp===null||timestamp<room.startedAt||timestamp>now()+60000)return;
    const eventId=String(raw.msgId??raw.common?.msgId??raw.eventId??randomUUID());if(room.seen.has(eventId))return;room.seen.add(eventId);if(room.seen.size>512)room.seen.delete(room.seen.values().next().value);
    const kanjiCandidate=!!Answers.parse(comment);
    for(const c of room.clients)if(timestamp>=c.joinedAt&&timestamp>=c.roundStartedAt&&(c.commentMode==='words'||kanjiCandidate))send(c,{type:'chat',comment,eventId,timestamp});
   });
   // Register the subscriber before connect() can synchronously emit events.
   client.room=room;room.clients.add(client);status(client,'TikTok LIVE�ɐڑ����c');
   room.timer=setTimer(()=>end(room,'LIVE�ւ̐ڑ����^�C���A�E�g���܂����B�Đڑ����Ă�������'),timeoutMs);
   Promise.resolve().then(()=>connection.connect()).then(()=>{if(room.closed){return Promise.resolve(connection.disconnect()).catch(()=>{})}room.ready=true;clearTimer(room.timer);for(const c of room.clients)status(c,'LIVE�ڑ��ς݁F�R�����g��ҋ@��')}).catch(error=>failure(room,error));
  }else{client.room=room;room.clients.add(client);status(client,room.ready?'LIVE�ڑ��ς݁F�R�����g��ҋ@��':'TikTok LIVE�ɐڑ����c')}
 };
 function attach(socket){
  if(stopped||clients.size>=maxClients){socket.close(1013,'capacity');return}
  const client={socket,room:null,subscriptionId:'',subscriptions:0,joinedAt:now(),roundStartedAt:now(),commentMode:'kanji'};clients.add(client);
  const handshake=setTimer(()=>{if(!client.room)socket.close(1008,'subscription required')},10000);
  socket.on('message',bytes=>{
   let payload;try{payload=JSON.parse(String(bytes))}catch{return}
   if(payload?.type==='subscribe'){clearTimer(handshake);subscribe(client,payload)}
   else if(payload?.type==='round'&&client.room&&payload.subscriptionId===client.subscriptionId){client.roundStartedAt=now()}
  });
  const dispose=()=>{clearTimer(handshake);release(client);clients.delete(client)};socket.on('close',dispose);socket.on('error',dispose);
 }
 return {attach,stats:()=>({rooms:rooms.size,clients:clients.size}),close:()=>{stopped=true;for(const client of [...clients]){release(client);client.socket.close(1001,'shutdown')}clients.clear()}};
}

