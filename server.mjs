// SPDX-License-Identifier: AGPL-3.0-only
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {WebSocketServer} from 'ws';
import {createRelay} from './relay.mjs';
import {createAccess,parseGrants,firebaseVerifier} from './access.mjs';

export function createServer({createConnection,verify,grants,origins=new Set(),trustProxy=false,accessOptions={}}){
 const relay=createRelay({createConnection,onDiagnostic:()=>console.warn('LIVE_UPSTREAM_FAILURE')});
 const access=createAccess({relay,verify,grants,...accessOptions});
 const sourceFiles=['answer-comments.cjs','relay.mjs','access.mjs','server.mjs','relay.test.mjs','access.test.mjs','credentials.test.mjs','firebase-offline.test.mjs','server.test.mjs','DEPLOYMENT.md','render.yaml','package.json','package-lock.json','Dockerfile','README.md','LICENSE','THIRD_PARTY_NOTICES.md'];
 const server=http.createServer((req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cache-Control','no-store');
  if(req.method!=='GET'){res.writeHead(405);res.end();return}
  if(req.url==='/health'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,protocol:2,authentication:'required'}));return}
  if(req.url==='/source'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end('<h1>Nazore LIVE relay source (AGPL-3.0-only)</h1>'+sourceFiles.map(name=>'<p><a href="/source/'+name+'">'+name+'</a></p>').join(''));return}
  const name=req.url?.startsWith('/source/')?req.url.slice(8):'';
  if(sourceFiles.includes(name)){try{res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end(readFileSync(new URL('./'+name,import.meta.url)));return}catch{res.end();return}}
  res.writeHead(404);res.end();
 });
 const sockets=new WebSocketServer({noServer:true,maxPayload:20000,perMessageDeflate:false});
 server.on('upgrade',(req,socket,head)=>{
  const origin=req.headers.origin;
  if(req.url!=='/live'||(origin&&!origins.has(origin))){socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return}
  sockets.handleUpgrade(req,socket,head,ws=>{const forwarded=trustProxy&&String(req.headers['x-forwarded-for']||'').split(',').at(-1).trim();access.attach(ws,{ip:forwarded||req.socket.remoteAddress||'unknown'})});
 });
 const close=()=>{access.close();relay.close();sockets.close();server.close()};
 return {server,close};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 let running,failing=false;const fatal=()=>{if(failing)return;failing=true;console.error('NAZORE_RELAY_FATAL');running?.close();process.exitCode=1;setTimeout(()=>process.exit(1),100).unref()};
 process.on('uncaughtException',fatal);process.on('unhandledRejection',fatal);
 try{
 if(process.env.DEBUG||process.env.NODE_DEBUG||process.env.DEBUG_DESERIALIZE_XD||process.env.GOOGLE_SDK_NODE_LOGGING||process.env.GRPC_TRACE)throw Error('Raw debug logging forbidden');
 const grants=parseGrants(process.env.NAZORE_LIVE_GRANTS_JSON);
 const origins=new Set(String(process.env.NAZORE_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean));
 if(!origins.size)throw Error('Origin configuration required');
 const verify=await firebaseVerifier({projectId:process.env.FIREBASE_PROJECT_ID,appIds:new Set(String(process.env.FIREBASE_APP_IDS||'').split(',').map(x=>x.trim()).filter(Boolean))});
 const {TikTokLiveConnection}=await import('tiktok-live-connector');
 const app=running=createServer({grants,origins,verify,trustProxy:process.env.NAZORE_TRUST_PROXY==='1',createConnection:id=>new TikTokLiveConnection(id,{processInitialData:false,fetchRoomInfoOnConnect:true,enableExtendedGiftInfo:false,authenticateWs:false,...(process.env.EULER_API_KEY?{signApiKey:process.env.EULER_API_KEY}:{}),webClientOptions:{timeout:{request:10000}},wsClientOptions:{handshakeTimeout:10000}})});
 app.server.listen(Number(process.env.PORT||8787),process.env.HOST||'127.0.0.1',()=>console.log('NAZORE_RELAY_READY_PROTOCOL_2'));
 process.once('SIGTERM',app.close);process.once('SIGINT',app.close);
 }catch{fatal()}
}
