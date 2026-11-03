import test from "node:test";
import assert from "node:assert/strict";
import { inconclusiveEnginesLabel } from "../src/lib/scanSession";

test("a lista de motores com lacunas e' explicita e nao inventa um total unico", () => {
  assert.equal(inconclusiveEnginesLabel(undefined), null);
  assert.equal(inconclusiveEnginesLabel([]), null);
  assert.equal(
    inconclusiveEnginesLabel([
      { engine: "native", count: 2 },
      { engine: "yara", count: 1 },
    ]),
    "1 ficheiro (YARA), 2 ficheiros (motor nativo)",
  );
});
