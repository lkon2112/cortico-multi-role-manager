import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,existsSync,readFileSync,writeFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createManager} from '../src/server.ts';
import {writeJson,json} from '../src/io.ts';
import {EMPTY_COPY} from '../src/types.ts';
import {normalizeCopy} from '../src/clone.ts';
const source=process.env.CORTICO_MANAGER_TEST_SOURCE;
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(fn:()=>Promise<boolean>,ms=20000){const end=Date.now()+ms;while(Date.now()<end){try{if(await fn())return;}catch{}await sleep(100);}throw Error('Timed out');}
test('copy dependencies are explicit',()=>{assert.equal(normalizeCopy({pending:true}).memory,true);assert.equal(normalizeCopy({timers:true}).session,false);});
test('standalone manager against an unchanged official Cortico', {skip:!source,timeout:240000}, async t=>{
 const root=mkdtempSync(join(tmpdir(),'cortico-manager-e2e-'));
 const guard=fileURLToPath(new URL('./network-guard.cjs',import.meta.url));
 const server=createServer();await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;await new Promise<void>(r=>server.close(()=>r()));
 const m=await createManager({source:resolve(source!),root,port,host:'127.0.0.1',env:{NODE_OPTIONS:`--require=${guard}`}});
 const base=`http://127.0.0.1:${port}`;let cookie='';
 async function request(path:string,body?:unknown,token=cookie){return fetch(base+path,{method:body===undefined?'GET':'POST',headers:{cookie:token,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});}
 async function api(path:string,body?:unknown){const r=await request(path,body);const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;}
 async function login(password='standalone-test-password'){const r=await request('/api/auth/login',{password});assert.equal(r.status,200);cookie=r.headers.get('set-cookie')!.split(';')[0];}
 async function create(id:string,bot='cormini',extra={}){const j=await api('/api/jobs',{id,name:id,bot,copy:EMPTY_COPY,allowStop:true,...extra});await m.jobs.wait();const done=m.jobs.list().find(x=>x.id===j.id)!;assert.equal(done.status,'done',done.error);await api('/api/roles');return m.supervisor.role(id);}
 const raw=(id:string,path:string,body?:unknown)=>{const r=m.supervisor.role(id);return fetch(`http://127.0.0.1:${r.port}${path}`,{method:body===undefined?'GET':'POST',headers:{cookie,...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});};
 try {
  await t.test('first-password setup and protected API',async()=>{
   assert.equal((await api('/api/auth/status')).setupRequired,true);assert.equal((await request('/api/roles')).status,401);
   const setup=await request('/api/auth/setup',{password:'standalone-test-password',confirmPassword:'standalone-test-password'});assert.equal(setup.status,200);cookie=setup.headers.get('set-cookie')!.split(';')[0];
   assert.equal((await request('/api/auth/setup',{password:'another-test-password',confirmPassword:'another-test-password'})).status,409);
   assert.ok((await api('/api/templates')).some((p:any)=>p.id==='cormini'));
  });
  await t.test('three official templates start in isolated directories',async()=>{
   for(const [id,bot] of [['alpha','cormini'],['beta','cortiv'],['gamma','corti-soulmate']]){
    await create(id,bot);const cfg=json<any>(join(root,'deployments',id,'config.json'),{});cfg.tick={intervalMinutes:null};cfg.worlds={console:{enabled:true},qq:{enabled:false},minecraft:{enabled:false},bilibili:{enabled:false},websearch:{enabled:false}};writeJson(join(root,'deployments',id,'config.json'),cfg);
    await api(`/api/roles/${id}/start`,{});assert.equal(m.supervisor.role(id).state,'paused');
    assert.equal((await(await raw(id,'/api/status')).json()).displayName,id);
   }
  });
  await t.test('transparent HTML, cross-role auth, native controls and websocket',async()=>{
   assert.equal(await(await raw('alpha','/?__cortico_frame=1')).text(),await(await m.supervisor.request('alpha','/')).text());
   const entry=await fetch(`http://127.0.0.1:${m.supervisor.role('alpha').port}/`);
   assert.equal(entry.status,200);assert.match(await entry.text(),/role\/alpha/);
   assert.equal((await raw('alpha','/')).headers.get('set-cookie'),null);
   const r=m.supervisor.role('alpha');assert.equal((await fetch(`http://127.0.0.1:${r.port}/api/status`)).status,401);
   await raw('alpha','/api/run/resume',{});await m.supervisor.refresh();assert.equal(m.supervisor.role('alpha').state,'running');assert.equal(m.supervisor.role('beta').state,'paused');
   await api('/api/roles/alpha/pause',{});
   const ws=new WebSocket(`ws://127.0.0.1:${r.port}/ws/providers/world%3Aconsole/panels/chat`,{headers:{cookie,origin:`http://127.0.0.1:${r.port}`}});await once(ws,'open');
   const closed=once(ws,'close');const old=cookie;await api('/api/auth/logout',{});await closed;assert.equal((await request('/api/roles',undefined,old)).status,401);await login();
  });
  await t.test('native restart remains supervised by official launcher',async()=>{
   const lock=join(root,'deployments/alpha/data/instance.lock');const pid=json<any>(lock).pid;
   assert.equal((await raw('alpha','/api/run/restart',{})).status,200);
   await until(async()=>typeof json<any>(lock,{}).pid==='number' && json<any>(lock,{}).pid!==pid && (await raw('alpha','/api/status')).ok);
   assert.equal((await(await raw('alpha','/api/status')).json()).loop.paused,true);
  });
  await t.test('stop directly after a native restart waits for the replacement Core',async()=>{
   assert.equal((await raw('alpha','/api/run/restart',{})).status,200);
   await api('/api/roles/alpha/stop',{});
   assert.equal(m.supervisor.role('alpha').state,'stopped');m.supervisor.assertStopped('alpha');
   assert.match(await(await raw('alpha','/')).text(),/role\/alpha/);
   assert.equal((await raw('alpha','/?__cortico_frame=1')).status,503);
   await api('/api/roles/alpha/start',{});
  });
  await t.test('password change revokes all gateways without stopping roles',async()=>{
   const old=cookie;await api('/api/auth/password',{currentPassword:'standalone-test-password',password:'changed-test-password',confirmPassword:'changed-test-password'});
   assert.equal((await request('/api/roles',undefined,old)).status,401);await login('changed-test-password');assert.ok((await raw('beta','/api/status')).ok);
  });
  await t.test('selective and full clone, stop and restore source',async()=>{
   await api('/api/roles/alpha/stop',{});const dir=join(root,'deployments/alpha');
   mkdirSync(join(dir,'workspace/note'),{recursive:true});writeFileSync(join(dir,'workspace/note/check.md'),'synthetic independent memory');
   const cfg=json<any>(join(dir,'config.json'));cfg.worlds.qq={enabled:false,token:'fake-qq-token',groups:[123],wsUrl:'ws://127.0.0.1:1'};writeJson(join(dir,'config.json'),cfg);
   await api('/api/roles/alpha/start',{});
   await create('light','cormini',{source:'alpha'});
   assert.equal(existsSync(join(root,'deployments/light/workspace/note/check.md')),false);
   assert.equal(json<any>(join(root,'deployments/light/config.json')).worlds.qq.token,undefined);
   mkdirSync(join(dir,'data/unmapped-plugin'),{recursive:true});
   writeFileSync(join(dir,'data/unmapped-plugin/state.json'),'unknown plugin state');
   writeFileSync(join(dir,'.env'),'CUSTOM_TOKEN=fake-clone-test\n');
   await create('full','cormini',{source:'alpha',copyMode:'full'});
   assert.equal(m.supervisor.role('alpha').state,'paused');assert.equal(m.supervisor.role('full').state,'stopped');
   assert.equal(readFileSync(join(root,'deployments/full/workspace/note/check.md'),'utf8'),'synthetic independent memory');
   assert.equal(existsSync(join(root,'deployments/full/data/web-auth.key')),false);
   assert.equal(json<any>(join(root,'deployments/full/config.json')).worlds.qq.token,'fake-qq-token');
   assert.equal(readFileSync(join(root,'deployments/full/data/unmapped-plugin/state.json'),'utf8'),'unknown plugin state');
   const review=await api('/api/roles/full/clone-review');assert.equal(review.mode,'full');
   await api('/api/roles/full/world-enabled',{world:'qq',enabled:true});
   assert.equal((await api('/api/roles/full/clone-review')).worlds.find((w:any)=>w.id==='qq').enabled,true);
   assert.equal((await request('/api/roles/full/world-enabled',{world:'qq',enabled:'false'})).status,400);
   await api('/api/roles/full/world-enabled',{world:'qq',enabled:false});
   assert.equal((await api('/api/roles/full/clone-review')).worlds.find((w:any)=>w.id==='qq').enabled,false);
   assert.equal((await request('/api/roles/alpha/world-enabled',{world:'qq',enabled:false})).status,400);
   await api('/api/roles/full/start',{});assert.ok((await raw('full','/api/status')).ok);
   assert.equal((await request('/api/roles/full/world-enabled',{world:'qq',enabled:false})).status,400);
   // The other bundled personas also clone and boot through their original template.
   for(const [id,bot] of [['beta','cortiv'],['gamma','corti-soulmate']]){
    await create(id+'-copy',bot,{source:id,copy:{...EMPTY_COPY,memory:true,session:true}});
    await api(`/api/roles/${id}-copy/start`,{});assert.ok((await raw(id+'-copy','/api/status')).ok);
   }
  });
  await t.test('failed copy records reason and source resumes; retry succeeds',async()=>{
   const stage=join(root,'deployments/.creating-retry');mkdirSync(stage);
   const j=await api('/api/jobs',{id:'retry',name:'retry',bot:'cormini',source:'alpha',copy:{...EMPTY_COPY,memory:true},allowStop:true});await m.jobs.wait();
   assert.equal(m.jobs.list().find(x=>x.id===j.id)!.status,'failed');assert.equal(m.supervisor.role('alpha').state,'paused');
   rmSync(stage,{recursive:true});await create('retry','cormini',{source:'alpha',copy:{...EMPTY_COPY,memory:true}});
  });
  await t.test('schedules, recovery, deletion and history controls',async()=>{
   const now=new Date();m.operations.setSchedule({role:'alpha',action:'run',repeat:'once',next:new Date(+now+60000).toISOString()},now);await m.operations.tick(new Date(+now+61000));assert.equal(m.supervisor.role('alpha').state,'running');
   await api('/api/roles/alpha/pause',{});
   await api('/api/roles/full/delete',{});const entry=(await api('/api/trash')).find((r:any)=>r.id==='full');assert.ok(entry);
   await api(`/api/trash/${entry.key}/restore`,{});
   assert.equal(m.supervisor.role('full').cloned,true);
   assert.equal((await api('/api/roles/full/clone-review')).mode,'full');
   assert.equal((await api('/api/roles/full/clone-review')).worlds.find((w:any)=>w.id==='qq').enabled,false);
   await api('/api/roles/full/start',{});assert.ok((await raw('full','/api/status')).ok);
   await api('/api/roles/full/delete',{});await api('/api/trash/purge',{keys:(await api('/api/trash')).filter((r:any)=>r.id==='full').map((r:any)=>r.key)});
   assert.equal(existsSync(join(root,'deployments/full')),false);
   await api('/api/history/settings',{limit:10});assert.ok((await api('/api/operations')).length<=10);
   await api('/api/history/clear',{});assert.deepEqual(await api('/api/jobs'),[]);assert.deepEqual(await api('/api/operations'),[]);
  });
 }finally{await m.close();console.log('Isolated test data:',root);}
});
