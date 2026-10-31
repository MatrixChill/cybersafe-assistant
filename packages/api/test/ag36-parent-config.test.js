import { test } from "node:test";
import assert from "node:assert/strict";
import { parseParentAiConfiguration } from "../dist/ai-parent-config.js";
const message={type:"cybersafe-ai-configure",id:"12345678-1234-4234-8234-123456789abc",provider:"groq",apiKey:"synthetic-fixture-only-not-a-real-key"};
test("parent config pins provider destinations and rejects custom",()=>{assert.equal(parseParentAiConfiguration({...message,provider:"custom",baseURL:"http://attacker"}),null);assert.equal(parseParentAiConfiguration(message).config.baseURL,"https://api.groq.com/openai/v1");assert.equal(parseParentAiConfiguration({...message,provider:"openai"}).config.baseURL,"https://api.openai.com/v1");});
test("parent config accepts explicit removal, rejects malformed messages and secrets",()=>{assert.equal(parseParentAiConfiguration({...message,apiKey:null}).config.apiKey,"");for(const bad of [undefined,"",{}, {...message,id:"wrong"},{...message,apiKey:"short"},{...message,apiKey:"secret\ninvalidfixture"}])assert.equal(parseParentAiConfiguration(bad),null);});
