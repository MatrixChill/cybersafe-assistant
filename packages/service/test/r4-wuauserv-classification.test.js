import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecommendations } from "../../native-windows/src/windows-health-logic.ts";

function classify(service) {
  const input = {
    system: { available: false }, topCpu: [], topRam: [], connections: [], users: [], disks: [],
    firewall: { available: true, enabled: true, profiles: [] },
    services: [{name:"wuauserv",displayName:"Windows Update",status:"stopped",running:false,startType:"Manual",...service}],
  };
  return buildRecommendations(input).filter(r=>r.id==="service-down");
}
test("R4 wuauserv: parado com arranque manual não é indisponibilidade",()=>{
  assert.deepEqual(classify({}),[]);
  assert.deepEqual(classify({name:"WUAUSERV",startType:"manual"}),[]);
});
test("R4 wuauserv: desativado ou automático parado mantém alerta",()=>{
  for(const startType of ["Disabled","Auto","Automatic","unknown"]) {
    const alerts=classify({startType});assert.equal(alerts.length,1);
    assert.equal(alerts[0].severity,"high");assert.match(alerts[0].description,/Windows Update/);
  }
});
test("R4 wuauserv: falha explícita em serviço manual não é ocultada",()=>{
  for(const status of ["failed","error","startPending","unknown"])
    assert.equal(classify({status}).length,1);
});
test("R4 serviços: outros serviços importantes parados continuam a alertar",()=>{
  for(const name of ["mpssvc","WinDefend","Spooler","LanmanServer"])
    assert.equal(classify({name,displayName:name}).length,1);
});
test("R4 serviços: em execução não gera alerta e serviço irrelevante não entra na lista",()=>{
  assert.deepEqual(classify({running:true,status:"running"}),[]);
  assert.deepEqual(classify({name:"unrelated-service"}),[]);
});

test("R4 serviços: um problema real não volta a incluir wuauserv manual na recomendação",()=>{
  const input={system:{available:false},topCpu:[],topRam:[],connections:[],users:[],disks:[],
    firewall:{available:true,enabled:true,profiles:[]},
    services:[
      {name:"wuauserv",displayName:"Windows Update",status:"stopped",running:false,startType:"Manual"},
      {name:"mpssvc",displayName:"Windows Firewall",status:"stopped",running:false,startType:"Auto"},
    ]};
  const alert=buildRecommendations(input).find(r=>r.id==="service-down");
  assert.match(alert.description,/Windows Firewall/);
  assert.doesNotMatch(alert.description,/Windows Update/);
});
