import {expect,test} from 'bun:test';
import fixture from '../fixtures/singapore-plan.json';
import {parseMimoUsage, parseMimoDetail, fetchMimoSnapshot, QuotaError} from '../src/mimo';

test('named overlapping pools are separate, not summed, and fractions derive from counters',()=>{
 const pools=parseMimoUsage(fixture.usage);
 expect(pools.map(p=>[p.id,p.used,p.limit,p.remaining,p.remainingPercent])).toEqual([
 ['plan','6000000000','11000000000','5000000000','45.45'],
 ['monthly','6000000000','11000000000','5000000000','45.45'],
 ['compensation','0','0','0',null]]);
 const reordered=structuredClone(fixture.usage);reordered.data.usage.items.reverse();
 expect(parseMimoUsage(reordered)).toEqual(pools);
});
test('missing and duplicate pool identities cannot turn into a fabricated quota',()=>{
 const missing=structuredClone(fixture.usage);missing.data.usage.items.shift();
 expect(()=>parseMimoUsage(missing)).toThrow();
 const duplicate=structuredClone(fixture.usage);duplicate.data.usage.items.push(duplicate.data.usage.items[0]);
 expect(()=>parseMimoUsage(duplicate)).toThrow();
 expect(()=>parseMimoUsage({code:0,data:{items:[{used:0,limit:10}]}})).toThrow();
});
test('unknown compensation remains absent and invalid counters fail closed',()=>{
 const absent=structuredClone(fixture.usage);absent.data.usage.items.pop();
 expect(parseMimoUsage(absent)).toHaveLength(2);
 const bad=structuredClone(fixture.usage);bad.data.usage.items[0].used=-1;
 expect(()=>parseMimoUsage(bad)).toThrow();
});
test('expiry is UTC validity, never reset; ambiguous or invalid values rejected',()=>{
 expect(parseMimoDetail(fixture.detail)).toEqual({planName:'Standard',expiresAt:'2030-01-31T23:59:59.000Z',expired:false});
 for(const time of ['2030-02-30 00:00:00','2030-01-31T23:59:59','tomorrow']){
  const d=structuredClone(fixture.detail);d.data.currentPeriodEnd=time;
  expect(()=>parseMimoDetail(d)).toThrow();
 }
});
test('fetch uses only fixed GET routes with bounded cookie forwarding and no redirects', async()=>{
 const calls: {url:string,init:RequestInit}[]=[];
 const snapshot=await fetchMimoSnapshot('session=synthetic',new Date('2030-01-01T00:00:00Z'),{
 accountLabel:'My Singapore plan',fetch:async(input,init)=>{
  calls.push({url:String(input),init:init!});
  return Response.json(String(input).endsWith('/usage')?fixture.usage:fixture.detail);
 }});
 expect(calls.map(c=>c.url)).toEqual(['https://platform.xiaomimimo.com/api/v1/tokenPlan/usage','https://platform.xiaomimimo.com/api/v1/tokenPlan/detail']);
 for(const {init} of calls){expect(init.method).toBe('GET');expect(init.redirect).toBe('error');expect(new Headers(init.headers).get('Cookie')).toBe('session=synthetic');expect(new Headers(init.headers).get('x-timeZone')).toBe('Europe/Kiev');}
 expect(snapshot.region).toBe('sgp');expect(snapshot.accountLabel).toBe('My Singapore plan');expect(snapshot.resetsAt).toBeNull();expect(snapshot.error).toBeNull();
 expect(JSON.stringify(snapshot)).not.toContain('synthetic');
});
test('all upstream failures become only typed sanitized errors',async()=>{
 const cases:[()=>Response, 'auth_required'|'unavailable'|'schema_changed'][]=[
 [()=>new Response('secret-raw-cookie',{status:401}),'auth_required'],
 [()=>new Response('secret-raw-cookie',{status:403}),'auth_required'],
 [()=>new Response('secret-raw-cookie',{status:429}),'unavailable'],
 [()=>new Response('',{status:302,headers:{Location:'https://evil.invalid'}}),'unavailable'],
 [()=>new Response('<html>secret-raw-cookie</html>',{headers:{'Content-Type':'text/html'}}),'schema_changed'],
 [()=>Response.json({code:401,message:'secret-raw-cookie'}),'auth_required'],
 [()=>Response.json({code:123,message:'secret-raw-cookie'}),'unavailable'],
 [()=>new Response('{',{headers:{'Content-Type':'application/json'}}),'schema_changed'],
 [()=>new Response('x'.repeat(1048577),{headers:{'Content-Type':'application/json'}}),'schema_changed'],
 ];
 for(const [response,code] of cases){
  try{await fetchMimoSnapshot('s=synthetic',new Date(),{accountLabel:'Test',fetch:async()=>response()});throw new Error('should reject');}
  catch(error){expect(error).toBeInstanceOf(QuotaError);expect((error as QuotaError).code).toBe(code);expect(String(error)).not.toContain('secret-raw-cookie');}
 }
});
test('upstream timeout rejects instead of hanging a collector poll',async()=>{
 const waiting = new Promise<void>(resolve => setTimeout(resolve, 30));
 await expect(fetchMimoSnapshot('s=synthetic',new Date(),{accountLabel:'Test',timeoutMs:5,fetch:async(_url,init)=>{
  await new Promise((_resolve,reject)=>init.signal!.addEventListener('abort',()=>reject(new Error('private timeout')),{once:true}));
  return Response.json(fixture.usage);
 }})).rejects.toMatchObject({code:'unavailable'});
 await waiting;
});
test('abort/transport failure and secret control characters never leak',async()=>{
 await expect(fetchMimoSnapshot('a=ok',new Date(),{accountLabel:'Test',fetch:async()=>{throw new Error('private-session');}})).rejects.toMatchObject({code:'unavailable'});
 let calls=0;
 await expect(fetchMimoSnapshot('a=ok\r\nx=evil',new Date(),{accountLabel:'Test',fetch:async()=>{calls++;return Response.json(fixture.usage);}})).rejects.toMatchObject({code:'auth_required'});
 expect(calls).toBe(0);
});
