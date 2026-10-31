import {test} from "node:test";
import assert from "node:assert/strict";
import {limitedSessionNowReady} from "../src/lib/bootReadiness";
test("limited session promotes only after complete readiness proof, never timeout/partial",()=>{assert.equal(limitedSessionNowReady("limited",{claimsReady:false}),false);assert.equal(limitedSessionNowReady("limited",{claimsReady:true}),true);assert.equal(limitedSessionNowReady("booting",{claimsReady:true}),false);assert.equal(limitedSessionNowReady("ready",{claimsReady:true}),false);});
