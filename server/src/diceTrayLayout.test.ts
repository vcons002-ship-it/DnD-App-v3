import {it,expect} from 'vitest';
import {createLiveWorld} from '../../shared/liveDicePhysics.js';
import {diceTrayLayoutForPool} from '../../shared/diceTrayLayout.js';

it('grows the tray without changing dice colliders, physical mass or gravity',()=>{
 const worlds=[1,4,10,20,40].map(count=>createLiveWorld(Array.from({length:count},(_,index)=>({sides:6,value:1,index,set:0})),42));
 const reference=worlds[0].bodies[0];let previous=1;
 for(const world of worlds){
  const frame=world.snapshot(),body=world.bodies[0];
  expect(frame.radius).toBe(1.1);
  expect(frame.trayScale).toBeGreaterThanOrEqual(previous);previous=frame.trayScale;
  expect(body.mass).toBeCloseTo(reference.mass,10);
  expect(body.shapes[0].boundingSphereRadius).toBeCloseTo(reference.shapes[0].boundingSphereRadius,10);
  expect(body.world!.gravity.toArray()).toEqual(reference.world!.gravity.toArray());
  expect(body.world!.bodies.some(b=>b.mass===0&&Math.abs(b.position.x-7.2*frame.trayScale)<1e-8)).toBe(true);
 }
 expect(worlds[0].snapshot().trayScale).toBe(1);
 expect(worlds.at(-1)!.snapshot().trayScale).toBeGreaterThan(worlds[2].snapshot().trayScale);
});

it('gives 4-12 die pools roomier tray scale and separates multi-wave appendDice pools',()=>{
 expect(diceTrayLayoutForPool(1).scale).toBe(1);
 expect(diceTrayLayoutForPool(6).scale).toBeGreaterThanOrEqual(1.35);
 expect(diceTrayLayoutForPool(12).scale).toBeGreaterThanOrEqual(1.55);

 for(const seed of [17,42,719]){
  const w=createLiveWorld([12,12,12].map((sides,index)=>({sides,value:1,index,set:0})),seed,'bottom',6);
  let f=w.snapshot();
  while(!f.done)f=w.advance(1/60);
  w.appendDice([12,12,12].map((sides,index)=>({sides,value:1,index:3+index,set:1})));
  f=w.snapshot();
  while(!f.done&&f.elapsed<20)f=w.advance(1/60);
  expect(f.done).toBe(true);
  expect(f.rerolls.reduce((s,n)=>s+n,0)).toBeLessThanOrEqual(2);
  for(let i=0;i<6;i++){
   expect(Math.abs(f.poses[i*7])).toBeLessThan(7*f.trayScale);
   expect(Math.abs(f.poses[i*7+1])).toBeLessThan(4.5*f.trayScale);
  }
 }
});
