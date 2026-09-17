/**
 * Pure credit accounting domain. NOT wired to checkout or production balances.
 * Persist each transition under a database transaction/row lock with a UNIQUE
 * event ID. Never call it with a browser-supplied grant or settlement amount.
 */
export type CreditCommand =
 | { id:string; workspace:string; kind:'grant'; credits:number; paymentReference:string }
 | { id:string; workspace:string; kind:'reserve'; job:string; credits:number; quoteVersion:string }
 | { id:string; workspace:string; kind:'settle'; job:string; credits:number }
 | { id:string; workspace:string; kind:'release'; job:string };
export interface Wallet {
 workspace:string; available:number; reserved:number; consumed:number;
 reservations:Record<string,{credits:number;quoteVersion:string;state:'reserved'|'settled'|'released'}>;
 applied:Record<string,string>;
}
export const emptyWallet=(workspace:string):Wallet=>({workspace,available:0,reserved:0,consumed:0,reservations:{},applied:{}});
function units(n:number,zero=false){if(!Number.isSafeInteger(n)||n<(zero?0:1))throw new Error('Credits must be safe nonnegative integer units');}
function name(s:string){if(typeof s!=='string'||!/^[a-zA-Z0-9_-]{1,120}$/.test(s))throw new Error('Invalid accounting identifier');}
function fingerprint(c:CreditCommand){return JSON.stringify(Object.fromEntries(Object.entries(c).sort(([a],[b])=>a.localeCompare(b))));}
export function transition(wallet:Wallet,c:CreditCommand):Wallet{
 name(c.id);name(c.workspace);if(c.workspace!==wallet.workspace)throw new Error('Cross-workspace accounting is forbidden');
 const identity=fingerprint(c);
 if(Object.hasOwn(wallet.applied,c.id)){if(wallet.applied[c.id]!==identity)throw new Error('Idempotency key reused for a different event');return wallet;}
 const next=structuredClone(wallet);
 if(c.kind==='grant'){
  units(c.credits);name(c.paymentReference);
  // One payment must never be granted again under a different event ID.
  for(const old of Object.values(next.applied)){const e=JSON.parse(old);if(e.kind==='grant'&&e.paymentReference===c.paymentReference)throw new Error('Payment already granted');}
  next.available+=c.credits;
 }else{
  name(c.job);
  if(c.kind==='reserve'){
   units(c.credits);name(c.quoteVersion);
   if(Object.hasOwn(next.reservations,c.job))throw new Error('Job already has a reservation');
   if(c.credits>next.available)throw new Error('Insufficient credits');
   next.available-=c.credits;next.reserved+=c.credits;
   Object.defineProperty(next.reservations,c.job,{value:{credits:c.credits,quoteVersion:c.quoteVersion,state:'reserved'},writable:true,enumerable:true,configurable:true});
  }else{
   if(!Object.hasOwn(next.reservations,c.job))throw new Error('No reservation for this job');
   const reservation=next.reservations[c.job];if(reservation.state!=='reserved')throw new Error('Reservation is already closed');
   if(c.kind==='settle'){
    units(c.credits,true);if(c.credits>reservation.credits)throw new Error('Settlement exceeds the approved cap');
    next.available+=reservation.credits-c.credits;next.consumed+=c.credits;reservation.state='settled';
   }else if(c.kind==='release'){next.available+=reservation.credits;reservation.state='released';}
   else throw new Error('Unknown credit command');
   next.reserved-=reservation.credits;
  }
 }
 for(const n of [next.available,next.reserved,next.consumed])units(n,true);
 Object.defineProperty(next.applied,c.id,{value:identity,writable:true,enumerable:true,configurable:true});
 return next;
}
