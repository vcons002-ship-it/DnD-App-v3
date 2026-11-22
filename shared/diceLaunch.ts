import {Vec3,type Body} from 'cannon-es';

/** Initial hand/cup tumble in radians per second. Contacts take over at release. */
export function handTumble(velocity:Vec3,random:()=>number):Vec3 {
  const heading=new Vec3(velocity.x,velocity.y,0);heading.normalize();
  const overhand=new Vec3(-heading.y,heading.x,0);
  const tumble=22+random()*8;
  const twist=(random()<.5?-1:1)*(7+random()*6);
  const spin=overhand.scale(tumble).vadd(heading.scale(twist));
  spin.z=(random()-.5)*16;
  return spin;
}

/** Release one handful together, with space between dice before first contact. */
export function releaseHandfulDie(
  body:Body,
  index:number,
  count:number,
  radius:number,
  trayScale:number,
  extent:number,
  crossExtent:number,
  metresPerUnit:number,
  gravity:number,
  direction:Vec3,
  cross:Vec3,
  random:()=>number,
  opts?:{crossOffset?:number;aimAngle?:number},
){
  const spread=count>6,spacing=radius*(spread?2.35:2.55);
  const lanes=Math.min(count,Math.max(1,Math.floor((crossExtent*2-radius*2)/spacing)+1));
  const lane=(index%lanes)-(lanes-1)/2,row=Math.floor(index/lanes);
  const laneSpan=Math.max(1,(lanes-1)/2);
  const aim=opts?.aimAngle??0;
  let angle:number;
  if(spread){
    angle=aim+(lanes>1?-(lane/Math.max(1,lanes-1))*.14:0);
  }else if(count===1){
    angle=opts?.aimAngle??(random()-.5)*.36;
  }else{
    angle=Math.max(-.38,Math.min(.38,aim+(lanes>1?(lane/laneSpan)*.14:0)+(random()-.5)*.14));
  }
  // Keep every lane inside the side walls without collapsing inter-lane spacing.
  const halfSpan=((lanes-1)/2)*spacing;
  const maxShift=Math.max(0,crossExtent-radius-halfSpan);
  const safeShift=Math.max(-maxShift,Math.min(maxShift,opts?.crossOffset??0));
  // Large handfuls use shallow rows behind the lead dice, not tall columns
  // landing on one another. All bodies start moving on the same physics step.
  const approach=radius+.4*trayScale+.005/metresPerUnit+(spread?row*spacing:0);
  body.position.copy(direction.scale(-extent-approach).vadd(cross.scale(safeShift+lane*spacing-Math.tan(aim)*(approach+radius))));
  body.position.z=((spread?.060:.070)+random()*.005)/metresPerUnit+(spread?0:row*radius*2.2);
  body.collisionFilterMask=1;
  body.quaternion.setFromEuler(random()*6.28,random()*6.28,random()*6.28);
  // The tray grows with the pool. Scale the throw's travel rather than letting
  // a larger handful drop in the front quarter of the enlarged bed.
  const speedScale=count>1?Math.sqrt(trayScale):1;
  const speed=(.55+random()*.15)*speedScale/metresPerUnit;
  body.velocity.copy(direction.scale(Math.cos(angle)*speed).vadd(cross.scale(Math.sin(angle)*speed)));
  // Small rolls leave the hand above the rim on a visible upward arc. Keep the
  // horizontal throw and large-handful clearance so the bed still gets used.
  body.velocity.z=(spread?.40+random()*.04:.30+random()*.04)/metresPerUnit;
  if(spread){
    // Rear rows must remain airborne until the whole die clears the rim.
    // Derive their height from the actual throw velocity and gravity, rather
    // than allowing them to strike the ground outside the entry wall.
    const clearanceTime=(approach+radius*3)/(Math.cos(angle)*speed);
    body.position.z=Math.max(body.position.z,gravity*clearanceTime*clearanceTime/2-body.velocity.z*clearanceTime+radius*.8);
  }
  body.angularVelocity.copy(handTumble(body.velocity,random));
}
