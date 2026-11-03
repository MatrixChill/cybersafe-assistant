interface DatabaseProbe {
  pragma(query:string,options:{simple:true}):unknown;
  prepare(query:string):{all():unknown};
}
/** Read-only check after the existing synchronous migrations have completed. */
export function databaseReadyForUpdate(db:DatabaseProbe):boolean {
  try {
    if(db.pragma('quick_check',{simple:true})!=='ok')return false;
    const rows=db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    if(!Array.isArray(rows))return false;
    const names=new Set(rows.map(row=>row&&typeof row==='object'?(row as {name?:unknown}).name:undefined));
    return ['users','threat_events','training_results'].every(name=>names.has(name));
  }catch{return false;}
}
