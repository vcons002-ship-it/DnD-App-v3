/** One 17.6 mm d6 reference at every pool size; only the tray footprint grows. */
export const REFERENCE_D6_EDGE=.0176;
export const FIXED_DICE_RADIUS=1.1;
export function diceTrayLayoutForPool(count:number){
  const n=Math.max(1,count);
  const cols=Math.max(1,Math.ceil(Math.sqrt(n*1.5))),rows=Math.max(1,Math.ceil(n/cols));
  const packed=Math.min(1.5,1.8/Math.pow(n,.25),5.6/cols,3.2/rows)*Math.min(1,Math.sqrt(12/n));
  // Give 3-14 die pools extra floor room so multi-wave dice, under-die rings,
  // and floating labels have generous clearance without crowding corners.
  const blend=Math.min(1,Math.max(0,(n-14)/12));
  const projectedRadius=packed*(.70+.30*blend*blend*(3-2*blend));
  const baseScale=Math.max(1,1/projectedRadius);
  const mediumBoost=n<=1?1:n<=2?1.04:1+Math.sqrt(n-1)*.19;
  // Tray growth is independent of die size, so larger dice stay visibly larger.
  const scale=Math.max(baseScale,mediumBoost);
  return {radius:FIXED_DICE_RADIUS,scale,halfWidth:7.2*scale,halfHeight:4.7*scale,innerHalfWidth:7*scale,innerHalfHeight:4.5*scale};
}

/** Slightly larger tapered/triangular dice; shared by contacts and rendering. */
export const diePhysicalScale=(sides:number)=>sides===10||sides===20?1.12:1;
