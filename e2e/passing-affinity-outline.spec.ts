import {test,expect,webglDisabled} from './helpers/test';
import {io} from 'socket.io-client';
import sharp from 'sharp';
import {DM_SECRET,PORT} from './playwright.config';
test.use({trace:'off'});

test('3D passing unit shows silhouette outline mid-walk in heavy darkness even when endpoint is out of view',async({page,request})=>{
 test.skip(webglDisabled,'This test verifies 3D silhouette outlines.');
 test.setTimeout(120000);
 const headers={'x-dm-passphrase':DM_SECRET},errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 const {code}=await(await request.post('/api/sessions',{headers,data:{name:'3D passing affinity outline heavy'}})).json();
 const buffer=await sharp({create:{width:3000,height:1600,channels:3,background:'#69705d'}}).png().toBuffer();
 const map=await(await request.post(`/api/sessions/${code}/maps`,{headers,multipart:{name:'Dark corridor',image:{name:'corridor.png',mimeType:'image/png',buffer}}})).json();
 const admin=io(`http://localhost:${PORT}`,{transports:['websocket']});
 const state=async()=>(await admin.timeout(15000).emitWithAck('join',{sessionCode:code,role:'dm',dmPassphrase:DM_SECRET})).snapshot;
 try{
  const s=await state(),pc=s.characters.find((c:any)=>c.name==='Druk');
  admin.emit('map:setActive',{mapId:map.id});
  for(const layer of ['map','tokens'])admin.emit('fog:setLayer',{mapId:map.id,layer,enabled:false});
  admin.emit('fog:setExploration',{mapId:map.id,mode:'remembered'});
  admin.emit('map:setEnvironment',{mapId:map.id,settings:{enabled:true,heavyDarkness:true,lighting:'dungeon',mist:false,lights:[]}});
  admin.emit('token:spawn',{mapId:map.id,kind:'pc',refId:pc.id,x:300,y:800});
  const pcToken=(await state()).tokens.find((t:any)=>t.kind==='pc');
  admin.emit('token:setLantern',{tokenId:pcToken.id,enabled:true});
  admin.emit('monster:create',{name:'Midpoint Goblin',modelType:'goblin',icon:'G',maxHp:20,armorClass:13,disposition:'enemy'});
  const template=(await state()).monsterTemplates.find((m:any)=>m.name==='Midpoint Goblin');
  admin.emit('token:spawn',{mapId:map.id,kind:'monster',refId:template.id,x:1000,y:800});
  const enemy=(await state()).tokens.find((t:any)=>t.kind==='monster');

  await page.addInitScript(()=>{
   localStorage.setItem('dnd.playerId','passing-3d-heavy');
   localStorage.setItem('dnd-environment-quality','balanced');
   localStorage.setItem('dnd.tokenView:passing-3d-heavy','3d');
   localStorage.setItem('dnd.monsterTokenView:passing-3d-heavy','3d');
  });
  await page.setViewportSize({width:1400,height:900});
  await page.goto(`/join?code=${code}`);
  await page.getByRole('button',{name:'Join',exact:true}).click();
  await page.locator('.claim-row').filter({hasText:'Druk'}).click();

  const models=page.getByTestId('miniature-layer');
  await expect(models).toHaveAttribute('data-miniature-status','ready',{timeout:60000});
  await expect(page.getByRole('progressbar')).toHaveCount(0,{timeout:60000});
  await expect.poll(()=>models.getAttribute('data-preloaded-model-urls').then(v=>v?.includes('goblin')??false),{timeout:60000}).toBe(true);
  await page.waitForTimeout(400);

  const outlined=()=>page.evaluate(()=> (document.querySelector('[data-testid="miniature-layer"]')?.getAttribute('data-outlined-token-ids')??'').split(',').filter(Boolean));
  const pcX=()=>page.evaluate(id=>(window as any).Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===id)?.x(),pcToken.id);
  await expect.poll(pcX).toBe(300);
  await expect.poll(outlined).not.toContain(enemy.id);

  const sampleWalk=async(destX:number)=>{
   await page.evaluate(({pcId,enemyId})=>{
    const w=window as any;
    w.__outlineSamples=[];
    w.__outlineSampleActive=true;
    const record=()=>{
     if(!w.__outlineSampleActive)return;
     const node=w.Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===pcId);
     const ids=(document.querySelector('[data-testid="miniature-layer"]')?.getAttribute('data-outlined-token-ids')??'').split(',').filter(Boolean);
     w.__outlineSamples.push({x:node?.x()??null,outlined:ids.includes(enemyId)});
     requestAnimationFrame(record);
    };
    record();
   },{pcId:pcToken.id,enemyId:enemy.id});
   admin.emit('token:move',{tokenId:pcToken.id,x:destX,y:800});
   await expect.poll(pcX,{timeout:20000}).toBe(destX);
   await page.waitForTimeout(350);
   return page.evaluate(()=>{const w=window as any;w.__outlineSampleActive=false;return w.__outlineSamples as {x:number|null;outlined:boolean}[];});
  };

  let samples=await sampleWalk(1700);
  if(!samples.some(s=>s.outlined)){
   // Wait for newly-discovered goblin's 3D instance to finish async shader warmup, then verify return pass.
   await expect(models).toHaveAttribute('data-miniature-count','2',{timeout:60000});
   await expect.poll(outlined).not.toContain(enemy.id);
   samples=await sampleWalk(300);
  }

  expect(samples[0]?.outlined).toBe(false);
  expect(samples.some(s=>s.outlined)).toBe(true);
  expect(samples.at(-1)?.outlined).toBe(false);
  await expect.poll(outlined).not.toContain(enemy.id);
  expect(errors).toEqual([]);
 }finally{admin.disconnect();}
});

test('3D passing unit shows silhouette outline mid-walk in dim light when endpoint is beyond darkvision range',async({page,request})=>{
 test.skip(webglDisabled,'This test verifies 3D silhouette outlines.');
 test.setTimeout(120000);
 const headers={'x-dm-passphrase':DM_SECRET},errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 const {code}=await(await request.post('/api/sessions',{headers,data:{name:'3D passing affinity outline dim'}})).json();
 const buffer=await sharp({create:{width:3000,height:1600,channels:3,background:'#69705d'}}).png().toBuffer();
 const map=await(await request.post(`/api/sessions/${code}/maps`,{headers,multipart:{name:'Dim corridor',image:{name:'dim.png',mimeType:'image/png',buffer}}})).json();
 const admin=io(`http://localhost:${PORT}`,{transports:['websocket']});
 const state=async()=>(await admin.timeout(15000).emitWithAck('join',{sessionCode:code,role:'dm',dmPassphrase:DM_SECRET})).snapshot;
 try{
  const s=await state(),pc=s.characters.find((c:any)=>c.name==='Druk');
  admin.emit('map:setActive',{mapId:map.id});
  for(const layer of ['map','tokens'])admin.emit('fog:setLayer',{mapId:map.id,layer,enabled:false});
  admin.emit('map:setEnvironment',{mapId:map.id,settings:{enabled:true,heavyDarkness:false,lighting:'dungeon',mist:false,lights:[]}});
  admin.emit('token:spawn',{mapId:map.id,kind:'pc',refId:pc.id,x:300,y:800});
  const pcToken=(await state()).tokens.find((t:any)=>t.kind==='pc');
  admin.emit('monster:create',{name:'Dim Goblin',modelType:'goblin',icon:'G',maxHp:20,armorClass:13,disposition:'enemy'});
  const template=(await state()).monsterTemplates.find((m:any)=>m.name==='Dim Goblin');
  admin.emit('token:spawn',{mapId:map.id,kind:'monster',refId:template.id,x:1000,y:800});
  const enemy=(await state()).tokens.find((t:any)=>t.kind==='monster');

  await page.addInitScript(()=>{
   localStorage.setItem('dnd.playerId','passing-3d-dim');
   localStorage.setItem('dnd-environment-quality','balanced');
   localStorage.setItem('dnd.tokenView:passing-3d-dim','3d');
   localStorage.setItem('dnd.monsterTokenView:passing-3d-dim','3d');
  });
  await page.setViewportSize({width:1400,height:900});
  await page.goto(`/join?code=${code}`);
  await page.getByRole('button',{name:'Join',exact:true}).click();
  await page.locator('.claim-row').filter({hasText:'Druk'}).click();

  const models=page.getByTestId('miniature-layer');
  await expect(models).toHaveAttribute('data-miniature-status','ready',{timeout:60000});
  await expect(models).toHaveAttribute('data-miniature-count','2',{timeout:60000});
  await page.waitForTimeout(400);

  const outlined=()=>page.evaluate(()=> (document.querySelector('[data-testid="miniature-layer"]')?.getAttribute('data-outlined-token-ids')??'').split(',').filter(Boolean));
  const pcX=()=>page.evaluate(id=>(window as any).Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===id)?.x(),pcToken.id);
  await expect.poll(pcX).toBe(300);
  await expect.poll(outlined).not.toContain(enemy.id);

  await page.evaluate(({pcId,enemyId})=>{
   const w=window as any;
   w.__dimSamples=[];
   w.__dimSampleActive=true;
   const record=()=>{
    if(!w.__dimSampleActive)return;
    const node=w.Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===pcId);
    const ids=(document.querySelector('[data-testid="miniature-layer"]')?.getAttribute('data-outlined-token-ids')??'').split(',').filter(Boolean);
    w.__dimSamples.push({x:node?.x()??null,outlined:ids.includes(enemyId)});
    requestAnimationFrame(record);
   };
   record();
  },{pcId:pcToken.id,enemyId:enemy.id});

  admin.emit('token:move',{tokenId:pcToken.id,x:1700,y:800});
  await expect.poll(pcX,{timeout:20000}).toBe(1700);
  await page.waitForTimeout(350);
  const samples=await page.evaluate(()=>{const w=window as any;w.__dimSampleActive=false;return w.__dimSamples as {x:number|null;outlined:boolean}[];});

  expect(samples[0]?.outlined).toBe(false);
  expect(samples.some(s=>s.outlined)).toBe(true);
  expect(samples.at(-1)?.outlined).toBe(false);
  await expect.poll(outlined).not.toContain(enemy.id);
  expect(errors).toEqual([]);
 }finally{admin.disconnect();}
});

test('2D passing unit shows affinity dot mid-walk when endpoint is out of view',async({page,request})=>{
 test.setTimeout(120000);
 const headers={'x-dm-passphrase':DM_SECRET},errors:string[]=[];
 page.on('pageerror',e=>errors.push(e.message));
 const {code}=await(await request.post('/api/sessions',{headers,data:{name:'2D passing affinity dot'}})).json();
 const buffer=await sharp({create:{width:3000,height:1600,channels:3,background:'#69705d'}}).png().toBuffer();
 const map=await(await request.post(`/api/sessions/${code}/maps`,{headers,multipart:{name:'2D corridor',image:{name:'corridor2d.png',mimeType:'image/png',buffer}}})).json();
 const admin=io(`http://localhost:${PORT}`,{transports:['websocket']});
 const state=async()=>(await admin.timeout(15000).emitWithAck('join',{sessionCode:code,role:'dm',dmPassphrase:DM_SECRET})).snapshot;
 try{
  const s=await state(),pc=s.characters.find((c:any)=>c.name==='Druk');
  admin.emit('map:setActive',{mapId:map.id});
  for(const layer of ['map','tokens'])admin.emit('fog:setLayer',{mapId:map.id,layer,enabled:false});
  admin.emit('fog:setExploration',{mapId:map.id,mode:'remembered'});
  admin.emit('map:setEnvironment',{mapId:map.id,settings:{enabled:true,heavyDarkness:true,lighting:'dungeon',mist:false,lights:[]}});
  admin.emit('token:spawn',{mapId:map.id,kind:'pc',refId:pc.id,x:300,y:800});
  const pcToken=(await state()).tokens.find((t:any)=>t.kind==='pc');
  admin.emit('token:setLantern',{tokenId:pcToken.id,enabled:true});
  admin.emit('monster:create',{name:'2D Goblin',modelType:'goblin',icon:'G',maxHp:20,armorClass:13,disposition:'enemy'});
  const template=(await state()).monsterTemplates.find((m:any)=>m.name==='2D Goblin');
  admin.emit('token:spawn',{mapId:map.id,kind:'monster',refId:template.id,x:1000,y:800});
  const enemy=(await state()).tokens.find((t:any)=>t.kind==='monster');

  await page.addInitScript(()=>{
   localStorage.setItem('dnd.playerId','passing-2d');
   localStorage.setItem('dnd-environment-quality','balanced');
   localStorage.setItem('dnd.tokenView:passing-2d','2d');
   localStorage.setItem('dnd.monsterTokenView:passing-2d','2d');
  });
  await page.setViewportSize({width:1400,height:900});
  await page.goto(`/join?code=${code}`);
  await page.getByRole('button',{name:'Join',exact:true}).click();
  await page.locator('.claim-row').filter({hasText:'Druk'}).click();

  const pcX=()=>page.evaluate(id=>(window as any).Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===id)?.x(),pcToken.id);
  const dotVisible=()=>page.evaluate(id=>{
   const nodes=(window as any).Konva.stages.flatMap((st:any)=>st.find('.token')).filter((n:any)=>n.getAttr('tokenId')===id);
   return nodes.some((n:any)=>{
    if(!n.isVisible()||n.getAbsoluteOpacity()<=0)return false;
    const dot=n.findOne('.token-affinity-dot');
    return !!dot&&dot.isVisible()&&dot.getAbsoluteOpacity()>0;
   });
  },enemy.id);

  await expect.poll(pcX).toBe(300);
  await expect.poll(dotVisible).toBe(false);

  await page.evaluate(({pcId,enemyId})=>{
   const w=window as any;
   w.__dotSamples=[];
   w.__dotSampleActive=true;
   const record=()=>{
    if(!w.__dotSampleActive)return;
    const all=(window as any).Konva.stages.flatMap((st:any)=>st.find('.token'));
    const pc=all.find((n:any)=>n.getAttr('tokenId')===pcId);
    const visible=all.filter((n:any)=>n.getAttr('tokenId')===enemyId).some((n:any)=>{
     if(!n.isVisible()||n.getAbsoluteOpacity()<=0)return false;
     const dot=n.findOne('.token-affinity-dot');
     return !!dot&&dot.isVisible()&&dot.getAbsoluteOpacity()>0;
    });
    w.__dotSamples.push({x:pc?.x()??null,dotVisible:visible});
    requestAnimationFrame(record);
   };
   record();
  },{pcId:pcToken.id,enemyId:enemy.id});

  admin.emit('token:move',{tokenId:pcToken.id,x:1700,y:800});
  await expect.poll(pcX,{timeout:20000}).toBe(1700);
  await page.waitForTimeout(350);
  const heavySamples=await page.evaluate(()=>{const w=window as any;w.__dotSampleActive=false;return w.__dotSamples as {x:number|null;dotVisible:boolean}[];});
  expect(heavySamples[0]?.dotVisible).toBe(false);
  expect(heavySamples.some(s=>s.dotVisible)).toBe(true);
  expect(heavySamples.at(-1)?.dotVisible).toBe(false);
  await expect.poll(dotVisible).toBe(false);

  // Dim light without lantern: enemy remains in Konva throughout, dot toggles live per frame.
  admin.emit('token:setLantern',{tokenId:pcToken.id,enabled:false});
  admin.emit('map:setEnvironment',{mapId:map.id,settings:{enabled:true,heavyDarkness:false,lighting:'dungeon',mist:false,lights:[]}});
  await expect.poll(dotVisible).toBe(false);
  await page.waitForTimeout(200);

  await page.evaluate(({pcId,enemyId})=>{
   const w=window as any;
   w.__dimDotSamples=[];
   w.__dimDotSampleActive=true;
   const record=()=>{
    if(!w.__dimDotSampleActive)return;
    const all=(window as any).Konva.stages.flatMap((st:any)=>st.find('.token'));
    const pc=all.find((n:any)=>n.getAttr('tokenId')===pcId);
    const visible=all.filter((n:any)=>n.getAttr('tokenId')===enemyId).some((n:any)=>{
     if(!n.isVisible()||n.getAbsoluteOpacity()<=0)return false;
     const dot=n.findOne('.token-affinity-dot');
     return !!dot&&dot.isVisible()&&dot.getAbsoluteOpacity()>0;
    });
    w.__dimDotSamples.push({x:pc?.x()??null,dotVisible:visible});
    requestAnimationFrame(record);
   };
   record();
  },{pcId:pcToken.id,enemyId:enemy.id});

  admin.emit('token:move',{tokenId:pcToken.id,x:300,y:800});
  await expect.poll(pcX,{timeout:20000}).toBe(300);
  await page.waitForTimeout(350);
  const dimSamples=await page.evaluate(()=>{const w=window as any;w.__dimDotSampleActive=false;return w.__dimDotSamples as {x:number|null;dotVisible:boolean}[];});
  expect(dimSamples[0]?.dotVisible).toBe(false);
  expect(dimSamples.some(s=>s.dotVisible)).toBe(true);
  expect(dimSamples.at(-1)?.dotVisible).toBe(false);
  await expect.poll(dotVisible).toBe(false);
  expect(errors).toEqual([]);
 }finally{admin.disconnect();}
});
