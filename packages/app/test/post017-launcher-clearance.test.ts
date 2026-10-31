import {test} from "node:test";
import assert from "node:assert/strict";
import * as geometry from "../src/lib/matrixLauncherPosition";
test("floating launcher reserves scroll clearance for its entire measured footprint, other modes release it",()=>{const fn=(geometry as unknown as {floatingLauncherClearance:(mode:string,size:{w:number;h:number})=>number}).floatingLauncherClearance;assert.equal(typeof fn,"function");assert.equal(fn("floating",{w:56,h:112}),136);assert.equal(fn("floating",{w:56,h:56}),80);assert.equal(fn("docked",{w:56,h:112}),0);assert.equal(fn("panel",{w:56,h:112}),0);});
