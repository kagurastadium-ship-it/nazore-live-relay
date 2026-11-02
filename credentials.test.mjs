import test from 'node:test';
import assert from 'node:assert/strict';
import {credentialVerifier} from './access.mjs';

test('both Firebase SDK verifiers are mandatory; ID-token revocation checking is enabled',async()=>{
 const calls=[];const verify=credentialVerifier({appIds:new Set(['approved-app']),auth:{async verifyIdToken(token,revoked){calls.push(['auth',revoked]);assert.equal(token,'identity');return{uid:'guest-uid',exp:2000}}},appCheck:{async verifyToken(token){calls.push(['app-check']);assert.equal(token,'attestation');return{appId:'approved-app',token:{exp:1000}}}}});
 assert.deepEqual(await verify({idToken:'identity',appCheckToken:'attestation'}),{uid:'guest-uid',expiresAt:1000000});assert.ok(calls.some(c=>c[0]==='auth'&&c[1]===true));assert.ok(calls.some(c=>c[0]==='app-check'));
});
test('Firebase SDK invalid, expired, revoked or disabled-user rejection cannot authorize',async()=>{
 for(const reason of ['invalid','expired','revoked','disabled']){const verify=credentialVerifier({appIds:new Set(['app']),auth:{async verifyIdToken(){throw Error(reason)}},appCheck:{async verifyToken(){return{appId:'app',token:{exp:1000}}}}});await assert.rejects(verify({idToken:'identity',appCheckToken:'attestation'}));}
});
test('other Firebase app IDs, invalid App Check and missing or oversized tokens are rejected',async()=>{
 const auth={async verifyIdToken(){return{uid:'uid',exp:1000}}};const verify=credentialVerifier({auth,appIds:new Set(['allowed']),appCheck:{async verifyToken(){return{appId:'foreign',token:{exp:1000}}}}});await assert.rejects(verify({idToken:'identity',appCheckToken:'attestation'}));await assert.rejects(verify({idToken:'x'.repeat(8193),appCheckToken:'attestation'}));await assert.rejects(verify({idToken:'identity'}));
 const bad=credentialVerifier({auth,appIds:new Set(['allowed']),appCheck:{async verifyToken(){throw Error('invalid')}}});await assert.rejects(bad({idToken:'identity',appCheckToken:'invalid'}));
});
