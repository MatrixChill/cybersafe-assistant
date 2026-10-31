/**
 * Fixture de corrida: lê/cria a credência como um arranque faria e devolve
 * apenas um DIGESTO e o estado `created`. O valor nunca sai para stdout — os
 * logs de teste não podem conter credenciais.
 */
import crypto from "node:crypto";
import { readOrCreatePipeCredential } from "../../src/pipe-credential.ts";

const dir = process.argv[2];
const info = readOrCreatePipeCredential(dir);
const digest = crypto.createHash("sha256").update(info.credential).digest("hex").slice(0, 16);
console.log(JSON.stringify({ digest, created: info.created, temForma: /^[a-f0-9]{64}$/.test(info.credential) }));
