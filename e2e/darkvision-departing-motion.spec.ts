import {test,expect} from './helpers/test';
import {io} from 'socket.io-client';
import sharp from 'sharp';
import {DM_SECRET,PORT} from './playwright.config';
test.use({trace:'off'});

for(const mode of ['standard','legacy'] as const){
 test(`${mode}: creature and party PC animate smoothly when moving outside darkvision without leaking unseen destination`,async({page,request})=>{
  test.setTimeout(120000);
  const headers={'x-dm-passphrase':DM_SECRET},errors:string[]=[];
  const wirePayloads:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('websocket',ws=>ws.on('framereceived',ev=>wirePayloads.push(String(ev.payload))));

  const {code}=await(await request.post('/api/sessions',{headers,data:{name:`Departing darkvision ${mode}`}})).json();
  const buffer=await sharp({create:{width:3000,height:1600,channels:3,background:'#69705d'}}).png().toBuffer();
  const map=await(await request.post(`/api/sessions/${code}/maps`,{headers,multipart:{name:'Dark cavern',image:{name:'cavern.png',mimeType:'image/png',buffer}}})).json();
  const admin=io(`http://localhost:${PORT}`,{transports:['websocket']});
  const state=async()=>(await admin.timeout(15000).emitWithAck('join',{sessionCode:code,role:'dm',dmPassphrase:DM_SECRET})).snapshot;

  try{
   const s=await state();
   const druk=s.characters.find((c:any)=>c.name==='Druk');
   const allyChar=s.characters.find((c:any)=>c.id!==druk.id);
   admin.emit('map:setActive',{mapId:map.id});
   admin.emit('map:setGrid',{mapId:map.id,gridSizePx:50,feetPerSquare:5,widthFt:300,locked:true});
   for(const layer of ['map','tokens'])admin.emit('fog:setLayer',{mapId:map.id,layer,enabled:false});
   admin.emit('fog:setExploration',{mapId:map.id,mode:'remembered'});
   admin.emit('map:setEnvironment',{mapId:map.id,settings:{enabled:true,heavyDarkness:true,lighting:'dungeon',mist:false,lights:[]}});
   admin.emit('token:spawn',{mapId:map.id,kind:'pc',refId:druk.id,x:400,y:800});
   admin.emit('token:spawn',{mapId:map.id,kind:'pc',refId:allyChar.id,x:400,y:900});
   admin.emit('monster:create',{name:'Shadow Goblin',modelType:'goblin',icon:'G',maxHp:20,armorClass:13,disposition:'enemy'});
   const template=(await state()).monsterTemplates.find((m:any)=>m.name==='Shadow Goblin');
   admin.emit('token:spawn',{mapId:map.id,kind:'monster',refId:template.id,x:700,y:800});

   const afterSpawn=await state();
   const allyTok=afterSpawn.tokens.find((t:any)=>t.refId===allyChar.id);
   const enemy=afterSpawn.tokens.find((t:any)=>t.kind==='monster');

   await page.addInitScript(({mode})=>{
    localStorage.setItem('dnd.playerId',`depart-${mode}`);
    localStorage.setItem('dnd-environment-quality',mode==='legacy'?'legacy':'low');
    localStorage.setItem(`dnd.tokenView:${`depart-${mode}`}`,'2d');
    localStorage.setItem(`dnd.monsterTokenView:${`depart-${mode}`}`,'2d');
   },{mode});
   await page.setViewportSize({width:1400,height:900});
   await page.goto(`/join?code=${code}`);
   await page.getByRole('button',{name:'Join',exact:true}).click();
   await page.locator('.claim-row').filter({hasText:'Druk'}).click();

   if(mode==='legacy')await expect(page.getByTestId('legacy-vision')).toHaveAttribute('data-geometry-source','server');
   else await expect(page.locator('.stage-wrap')).toHaveAttribute('data-render-mode','standard');

   const tokenState=(id:string)=>page.evaluate(tokenId=>{
    const node=(window as any).Konva?.stages?.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===tokenId);
    return node?{x:node.x() as number,visible:Boolean(node.isVisible()&&node.opacity()>0.01)}:null;
   },id);

   await expect.poll(()=>tokenState(enemy.id),{timeout:15000}).toMatchObject({x:700,visible:true});
   await expect.poll(()=>tokenState(allyTok.id),{timeout:15000}).toMatchObject({x:400,visible:true});
   await page.waitForTimeout(500);

   // 1. Enemy moves from inside 60 ft darkvision (x=700) to far outside (x=2000).
   const beforeGoblinWireCount=wirePayloads.length;
   await page.evaluate(enemyId=>{
    const w=window as any;
    w.__departSamples=[];
    w.__departActive=true;
    const sample=()=>{
     if(!w.__departActive)return;
     const node=w.Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===enemyId);
     w.__departSamples.push({x:node?node.x():null,visible:Boolean(node&&node.isVisible()&&node.opacity()>0.01)});
     requestAnimationFrame(sample);
    };
    sample();
   },enemy.id);

   await admin.timeout(15000).emitWithAck('token:move',{tokenId:enemy.id,x:2000,y:800});
   await expect.poll(()=>tokenState(enemy.id),{timeout:15000}).toBeNull();
   await page.waitForTimeout(150);
   const enemySamples=await page.evaluate(()=>{
    const w=window as any;
    w.__departActive=false;
    return w.__departSamples as {x:number|null;visible:boolean}[];
   });

   expect(enemySamples[0]?.visible).toBe(true);
   expect(enemySamples.some(p=>p.visible&&p.x!==null&&p.x>720&&p.x<1040)).toBe(true);
   expect(enemySamples.every(p=>!p.visible||(p.x!==null&&p.x<=1040))).toBe(true);
   expect(enemySamples.at(-1)?.visible).toBe(false);

   // Unseen destination coordinate (2000) must never appear in player WebSocket frames.
   const goblinMovePayloads=wirePayloads.slice(beforeGoblinWireCount).join('\n');
   expect(goblinMovePayloads).not.toContain('2000');

   // 2. Party PC moves from inside darkvision (x=700) to outside darkvision (x=1300) into revealedOnly shared sight.
   await page.evaluate(allyId=>{
    const w=window as any;
    w.__allySamples=[];
    w.__allyActive=true;
    const sample=()=>{
     if(!w.__allyActive)return;
     const node=w.Konva.stages.flatMap((st:any)=>st.find('.token')).find((n:any)=>n.getAttr('tokenId')===allyId);
     w.__allySamples.push({x:node?node.x():null,visible:Boolean(node&&node.isVisible()&&node.opacity()>0.01)});
     requestAnimationFrame(sample);
    };
    sample();
   },allyTok.id);

   await admin.timeout(15000).emitWithAck('token:move',{tokenId:allyTok.id,x:1300,y:900});
   await expect.poll(async()=>(await tokenState(allyTok.id))?.x,{timeout:15000}).toBe(1300);
   await page.waitForTimeout(150);
   const allySamples=await page.evaluate(()=>{
    const w=window as any;
    w.__allyActive=false;
    return w.__allySamples as {x:number|null;visible:boolean}[];
   });

   expect(allySamples.some(p=>p.visible&&p.x!==null&&p.x>740&&p.x<1260)).toBe(true);
   expect(allySamples.at(-1)?.x).toBe(1300);
   expect(errors).toEqual([]);
  }finally{admin.disconnect();}
 });
}
