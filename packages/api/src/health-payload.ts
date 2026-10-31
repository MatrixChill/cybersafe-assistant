/** Public correlation of one launched API child; not a token or an auth grant. */
export function apiHealthPayload(env:Record<string,string|undefined>={}):{status:'ok';service:'cybersafe-api';bootId?:string}{
 const id=env.CYBERSAFE_API_BOOT_ID;
 return {status:'ok',service:'cybersafe-api',...(typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)?{bootId:id}:{})};
}
