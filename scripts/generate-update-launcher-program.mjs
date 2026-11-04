import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const source = readFileSync(input, "utf8").replace(/\r\n/g, "\n");
const match = source.match(/export const WINDOWS_HANDOFF_SCRIPT = String\.raw`([\s\S]+)`;\s*$/);
if (!match || match[1].includes("`") || match[1].includes("${")) {
  throw new Error("Expected one static handoff program");
}
const encoded = Buffer.from(match[1], "utf16le").toString("base64");
if (encoded.length > 24000) throw new Error("Handoff program exceeds launcher limit");
const lines = encoded.match(/.{1,96}/g).map((chunk) => '  L"' + chunk + '"');
writeFileSync(output, "static constexpr wchar_t kHandoffProgram[] =\n" + lines.join("\n") + ";\n");
