import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {createManager} from '../src/server.ts';
import {EMPTY_COPY} from '../src/types.ts';
import {json,writeJson} from '../src/io.ts';
const before=process.env.CORTICO_MANAGER_TEST_OLD_SOURCE,after=process.env.CORTICO_MANAGER_TEST_SOURCE;
test('same deployments and manager login survive an official version change',{skip:!before||!after,timeout:60000},async()=>{
 const root=mkdtempSync(join(tmpdir(),'cortico-manager-upgrade-'));
 const listener=createServer();await new Promise<void>(r=>listener.listen(0,'127.0.0.1',r));const port=(listener.address() as {port:number}).port;await new Promise<void>(r=>listener.close(()=>r()));
 const options={root,port,host:'127.0.0.1',env:{NODE_OPTIONS:`--require=${fileURLToPath(new URL('./network-guard.cjs',import.meta.url))}`}};
 let cookie='',gateway=0;
 // Each version has a fresh HTTP session; only the login cookie and data persist.
 async function request(url:string,init:RequestInit={}){
  const response=await fetch(url,{...init,headers:{cookie,...init.headers,connection:'close'}});
  const body=await response.json();
  assert.equal(response.status,200,`${url}: ${JSON.stringify(body)}`);
  return {response,body};
 }
 for(const [index,source] of [before!,after!].entries()){
  const m=await createManager({...options,source:resolve(source)});
  try{
   if(index===0){
    const {response:setup}=await request(`http://127.0.0.1:${port}/api/auth/setup`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'upgrade-test-password',confirmPassword:'upgrade-test-password'})});cookie=setup.headers.get('set-cookie')!.split(';')[0];
    m.jobs.create({id:'same-role',name:'Same role',bot:'cormini',copy:EMPTY_COPY,allowStop:true});await m.jobs.wait();assert.equal(m.jobs.list()[0].status,'done');
    const dir=join(root,'deployments/same-role');const cfg=json<any>(join(dir,'config.json'));cfg.tick={intervalMinutes:null};writeJson(join(dir,'config.json'),cfg);
    mkdirSync(join(dir,'workspace/note'),{recursive:true});writeFileSync(join(dir,'workspace/note/upgrade.md'),'Preserve this local note.');gateway=m.supervisor.role('same-role').port;
   }
   const {body:roles}=await request(`http://127.0.0.1:${port}/api/roles`);
   assert.ok(roles.some((r:{id:string})=>r.id==='same-role'));
   await m.supervisor.start('same-role');await m.gateways.sync();
   assert.equal(m.supervisor.role('same-role').port,gateway);
   assert.equal((await request(`http://127.0.0.1:${gateway}/api/status`)).body.displayName,'Same role');
   assert.equal(readFileSync(join(root,'deployments/same-role/workspace/note/upgrade.md'),'utf8'),'Preserve this local note.');
   console.log('Official version verified:',json<any>(join(source,'package.json')).version);
  }finally{await m.close();}
 }
 console.log('Upgrade test data:',root);
});
