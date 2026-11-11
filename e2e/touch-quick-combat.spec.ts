import {test,expect} from './helpers/test';
import {io} from 'socket.io-client';
import sharp from 'sharp';
import {DM_SECRET,PORT} from './playwright.config';
import {waitForCombatRoll} from './helpers/combatLive';

test.use({hasTouch:true,isMobile:true,viewport:{width:900,height:700},trace:'off'});
for(const role of ['dm','player'] as const)for(const mode of ['legacy','standard'] as const)test(`${role} long press attacks with the selected companion in ${mode}`,async({page,request,context})=>{
 test.setTimeout(90000);
 const headers={'x-dm-passphrase':DM_SECRET};
 const {code}=await(await request.post('/api/sessions',{headers,data:{name:'Touch quick combat'}})).json();
 const image=await sharp({create:{width:1000,height:700,channels:3,background:'#59604b'}}).png().toBuffer();
 const map=await(await request.post(`/api/sessions/${code}/maps`,{headers,multipart:{name:'Room',image:{name:'room.png',mimeType:'image/png',buffer:image}}})).json();
 const dm=io(`http://localhost:${PORT}`,{transports:['websocket']});
 const state=async()=>(await dm.timeout(10000).emitWithAck('join',{sessionCode:code,role:'dm',dmPassphrase:DM_SECRET})).snapshot;
 try{
  const s=await state(),pc=s.characters.find((c:any)=>c.name==='Druk');dm.emit('map:setActive',{mapId:map.id});
  for(const layer of ['map','tokens'])dm.emit('fog:setLayer',{mapId:map.id,layer,enabled:false});
  dm.emit('token:spawn',{mapId:map.id,kind:'pc',refId:pc.id,x:250,y:350});
  for(const [name,disposition,x] of [['Touch Companion','friendly',450],['Touch Target','enemy',650]] as const){
   dm.emit('monster:create',{name,disposition,modelType:'goblin',maxHp:100,armorClass:10,weapons:[{name:'Companion Blade',kind:'ranged',range:'150/600',damage:'1d6',attackBonus:5,diceOnly:true}]});
   const template=(await state()).monsterTemplates.find((m:any)=>m.name===name);dm.emit('token:spawn',{mapId:map.id,kind:'monster',refId:template.id,x,y:350});
  }
  const ready=await state(),playerToken=ready.tokens.find((t:any)=>t.refId===pc.id),actor=ready.tokens.find((t:any)=>ready.monsters.some((m:any)=>m.id===t.refId&&m.name.startsWith('Touch Companion'))),target=ready.tokens.find((t:any)=>ready.monsters.some((m:any)=>m.id===t.refId&&m.name.startsWith('Touch Target')));
  await page.addInitScript(mode=>{localStorage.setItem('dnd-environment-quality',mode==='legacy'?'legacy':'low');localStorage.setItem('dnd-dice-rendering','2d');},mode);
  await page.goto(`/${role==='dm'?'dm':'join'}?code=${code}`);
  if(role==='dm'){await page.locator('input[type=password]').fill(DM_SECRET);await page.getByRole('button',{name:'Rejoin as DM',exact:true}).click();}
  else{await page.getByRole('button',{name:'Join',exact:true}).click();await page.locator('.claim-row').filter({hasText:'Druk'}).click();}
  await expect(page.locator('.stage-wrap')).toHaveAttribute('data-render-mode',mode==='legacy'?'legacy':'standard');
  await expect.poll(()=>page.evaluate(()=>(window as any).Konva?.stages.find((s:any)=>s.find('.token').length)?.find('.token').length??0)).toBe(3);
  if(mode==='standard')await expect(page.getByTestId('miniature-layer')).toHaveAttribute('data-miniature-ids',new RegExp(actor.id));
  const point=async(id:string)=>page.evaluate(id=>{const stage=(window as any).Konva.stages.find((s:any)=>s.find('.token').length),n=stage.find('.token').find((n:any)=>n.getAttr('tokenId')===id),p=n.getAbsolutePosition(),r=stage.getContent().getBoundingClientRect();return {x:r.left+p.x*r.width/stage.width(),y:r.top+p.y*r.height/stage.height()};},id);
  const a=await point(actor.id),b=await point(target.id);await page.touchscreen.tap(a.x,a.y);
  const touch=await context.newCDPSession(page);const hold=async(p:{x:number;y:number})=>{await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await page.waitForTimeout(650);await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
  const menu=page.getByRole('dialog',{name:'Token actions',exact:true});
  // Some touch browsers dispatch their native contextmenu before our hold timer.
  await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...b,id:1}]});
  await page.waitForTimeout(300);
  await page.evaluate(({id,x,y})=>{const stage=(window as any).Konva.stages.find((s:any)=>s.find('.token').length),node=stage.find('.token').find((n:any)=>n.getAttr('tokenId')===id);node.fire('contextmenu',{evt:{clientX:x,clientY:y,preventDefault(){}}},true);},{id:target.id,...b});
  await expect(menu.getByLabel('Act as')).toHaveValue(actor.id);
  await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(menu.getByLabel('Act as')).toHaveValue(actor.id);
  await menu.getByRole('button',{name:'Close token actions'}).click();
  await hold(b);await expect(menu).toBeVisible();
  await expect(menu.getByLabel('Act as')).toHaveValue(actor.id);
  await expect(menu).toContainText('Touch Target');await expect(menu).toContainText('Attacking as');await expect(menu).toContainText('Touch Companion');
  await menu.getByRole('button',{name:'Close token actions'}).click();
  // A subsequent ordinary tap must still select the touched token.
  await page.touchscreen.tap(b.x,b.y);await hold(a);await expect(menu).toBeVisible();
  await expect(menu.getByLabel('Act as')).toHaveValue(role==='dm'?target.id:playerToken.id);
  await menu.getByRole('button',{name:'Close token actions'}).click();
  await page.touchscreen.tap(a.x,a.y);await hold(b);await expect(menu.getByLabel('Act as')).toHaveValue(actor.id);
  const previous=new Set<string>((await state()).rollLog.map((roll:any)=>roll.id));
  await menu.getByRole('button',{name:/Companion Blade/}).click();
  const roll=await waitForCombatRoll(state,previous,r=>r.label==='Attack');
  expect(roll.reveal?.attacker).toContain('Touch Companion');expect(roll.reveal?.target).toContain('Touch Target');
 }finally{dm.disconnect();}
});

test.describe('phone portrait docking',()=>{
 test.use({viewport:{width:390,height:844}});
 test('phone portrait long-press menu docks vertically on the opposite side with compact header',async({page,request,context})=>{
  test.setTimeout(90000);
  const headers={'x-dm-passphrase':DM_SECRET};
  const {code}=await(await request.post('/api/sessions',{headers,data:{name:'Phone dock check'}})).json();
  const image=await sharp({create:{width:800,height:1200,channels:3,background:'#4b5648'}}).png().toBuffer();
  const map=await(await request.post(`/api/sessions/${code}/maps`,{headers,multipart:{name:'Hall',image:{name:'hall.png',mimeType:'image/png',buffer:image}}})).json();
  const dm=io(`http://localhost:${PORT}`,{transports:['websocket']});
  const state=async()=>(await dm.timeout(10000).emitWithAck('join',{sessionCode:code,role:'dm',dmPassphrase:DM_SECRET})).snapshot;
  try{
   const s=await state(),pc=s.characters.find((c:any)=>c.name==='Druk');dm.emit('map:setActive',{mapId:map.id});
   dm.emit('character:update',{characterId:pc.id,weapons:[
    {name:'Greataxe',kind:'melee',damage:'1d12+3',versatileDamage:'1d12+3',attackBonus:5},
    {name:'Handaxe',kind:'thrown',range:'20/60',damage:'1d6+3',attackBonus:5},
    {name:'Javelin',kind:'thrown',range:'30/120',damage:'1d6+3',attackBonus:5},
    {name:'Longbow',kind:'ranged',range:'150/600',damage:'1d8+2',attackBonus:4},
    {name:'Warhammer',kind:'melee',damage:'1d8+3',versatileDamage:'1d10+3',attackBonus:5},
   ]});
   for(const layer of ['map','tokens'])dm.emit('fog:setLayer',{mapId:map.id,layer,enabled:false});
   dm.emit('token:spawn',{mapId:map.id,kind:'pc',refId:pc.id,x:220,y:440});
   for(const [name,tx,ty] of [['Left Target',220,620],['Right Target',640,620]] as const){
    dm.emit('monster:create',{name,disposition:'enemy',modelType:'goblin',maxHp:30,armorClass:12,weapons:[{name:'Claw',kind:'melee',damage:'1d6',attackBonus:4,diceOnly:true}]});
    const tpl=(await state()).monsterTemplates.find((m:any)=>m.name===name);dm.emit('token:spawn',{mapId:map.id,kind:'monster',refId:tpl.id,x:tx,y:ty});
   }
   const ready=await state();
   const playerTok=ready.tokens.find((t:any)=>t.refId===pc.id);
   const leftTarget=ready.tokens.find((t:any)=>ready.monsters.some((m:any)=>m.id===t.refId&&m.name.startsWith('Left Target')));
   const rightTarget=ready.tokens.find((t:any)=>ready.monsters.some((m:any)=>m.id===t.refId&&m.name.startsWith('Right Target')));
   await page.addInitScript(()=>{localStorage.setItem('dnd-environment-quality','legacy');localStorage.setItem('dnd-dice-rendering','2d');});
   await page.goto(`/join?code=${code}`);
   await page.getByRole('button',{name:'Join',exact:true}).click();
   await page.locator('.claim-row').filter({hasText:'Druk'}).click();
   await expect(page.locator('.player-claim')).toBeHidden();
   await expect.poll(()=>page.evaluate(()=>(window as any).Konva?.stages.find((s:any)=>s.find('.token').length)?.find('.token').length??0)).toBe(3);
   const point=async(id:string)=>page.evaluate(id=>{const stage=(window as any).Konva.stages.find((s:any)=>s.find('.token').length),n=stage.find('.token').find((n:any)=>n.getAttr('tokenId')===id),p=n.getAbsolutePosition(),r=stage.getContent().getBoundingClientRect();return {x:Math.round(r.left+p.x*r.width/stage.width()),y:Math.round(r.top+p.y*r.height/stage.height())};},id);
   const pPlayer=await point(playerTok.id);
   await page.touchscreen.tap(pPlayer.x,pPlayer.y);
   const touch=await context.newCDPSession(page);
   const hold=async(p:{x:number;y:number})=>{await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{...p,id:1}]});await page.waitForTimeout(650);await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});};
   const menu=page.getByRole('dialog',{name:'Token actions',exact:true});

   // Left-half target -> docks vertically on the right edge, leaving left target & tether clear and all 5 weapons visible without scrolling.
   const pLeft=await point(leftTarget.id);
   await hold(pLeft);
   await expect(menu).toBeVisible();
   await expect(menu).toHaveAttribute('data-dock','right');
   for(const w of ['Greataxe','Handaxe','Javelin','Longbow','Warhammer']){
    await expect(menu.getByRole('button',{name:new RegExp(w)})).toBeInViewport();
   }
   const rightBox=await menu.boundingBox();
   expect(rightBox).not.toBeNull();
   expect(rightBox!.width).toBeLessThanOrEqual(200);
   expect(rightBox!.x).toBeGreaterThan(pLeft.x+30);

   // Flip button moves it cleanly to the left edge.
   await menu.getByRole('button',{name:'Move token actions to opposite edge'}).click();
   await expect(menu).toHaveAttribute('data-dock','left');
   const leftBox=await menu.boundingBox();
   expect(leftBox).not.toBeNull();
   expect(leftBox!.x).toBeLessThan(20);
   await menu.getByRole('button',{name:'Close token actions'}).click();

   // Right-half target -> automatically docks vertically on the left edge without covering the target.
   const pRight=await point(rightTarget.id);
   expect(pRight.x).toBeGreaterThan(240);
   await hold(pRight);
   await expect(menu).toBeVisible();
   await expect(menu).toHaveAttribute('data-dock','left');
   const autoLeftBox=await menu.boundingBox();
   expect(autoLeftBox).not.toBeNull();
   expect(autoLeftBox!.x+autoLeftBox!.width).toBeLessThan(pRight.x-30);
  }finally{dm.disconnect();}
 });
});
