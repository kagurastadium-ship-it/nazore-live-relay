// Offline cryptographic SDK tests: generated keys stay in memory; no Firebase writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,sign,randomUUID} from 'node:crypto';
import {initializeApp,deleteApp} from 'firebase-admin/app';
import {getAuth} from 'firebase-admin/auth';
import {getAppCheck} from 'firebase-admin/app-check';
import {credentialVerifier} from './access.mjs';

const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const otherKeys=generateKeyPairSync('rsa',{modulusLength:2048});
function token(payload,key=keys.privateKey){const h=Buffer.from(JSON.stringify({alg:'RS256',typ:'JWT',kid:'offline-key'})).toString('base64url'),p=Buffer.from(JSON.stringify(payload)).toString('base64url'),body=h+'.'+p;return body+'.'+sign('RSA-SHA256',Buffer.from(body),key).toString('base64url')}
function fixture(t){
 const project='demo-nazore-relay-tests',now=Math.floor(Date.now()/1000),app=initializeApp({projectId:project,credential:{async getAccessToken(){throw Error('Network is forbidden in this test')}}},'offline-'+randomUUID());t.after(()=>deleteApp(app));
 const auth=getAuth(app),appCheck=getAppCheck(app),fetcher={async fetchPublicKeys(){return{'offline-key':keys.publicKey.export({type:'spki',format:'pem'})}}};
 // Replace only certificate download and account lookup; SDK signature/claims validation stays real.
 auth.idTokenVerifier.signatureVerifier.keyFetcher=fetcher;appCheck.appCheckTokenVerifier.signatureVerifier.keyFetcher=fetcher;
 let user={disabled:false,tokensValidAfterTime:new Date(0).toISOString()};auth.getUser=async()=>user;
 const identity={aud:project,iss:'https://securetoken.google.com/'+project,sub:'owner',iat:now,exp:now+3600,auth_time:now-1,firebase:{sign_in_provider:'anonymous'}};
 const attestation={aud:['projects/'+project],iss:'https://firebaseappcheck.googleapis.com/123456',sub:'approved-app',iat:now,exp:now+1800};
 return {verify:credentialVerifier({auth,appCheck,appIds:new Set(['approved-app'])}),identity,attestation,setUser:value=>{user=value}};
}
test('real Firebase SDK accepts properly signed anonymous ID and App Check fixtures',async t=>{
 const f=fixture(t),result=await f.verify({idToken:token(f.identity),appCheckToken:token(f.attestation)});assert.equal(result.uid,'owner');assert.equal(result.expiresAt,f.attestation.exp*1000);
});
test('real Firebase SDK rejects bad signatures, wrong project, expired ID and expired App Check',async t=>{
 const f=fixture(t),valid={idToken:token(f.identity),appCheckToken:token(f.attestation)};
 for(const overrides of [{idToken:token(f.identity,otherKeys.privateKey)},{idToken:token({...f.identity,aud:'another-project'})},{idToken:token({...f.identity,exp:1})},{appCheckToken:token({...f.attestation,exp:1})},{appCheckToken:token({...f.attestation,sub:'foreign-app'})}])await assert.rejects(f.verify({...valid,...overrides}));
});
test('real Firebase SDK revocation and disabled-user checks remain active',async t=>{
 const f=fixture(t),tokens={idToken:token(f.identity),appCheckToken:token(f.attestation)};f.setUser({disabled:true});await assert.rejects(f.verify(tokens));f.setUser({disabled:false,tokensValidAfterTime:new Date(Date.now()+10000).toISOString()});await assert.rejects(f.verify(tokens));
});
