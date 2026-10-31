import multer from "multer";
import type { RequestHandler } from "express";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_FILE_BYTES + 64 * 1024;

/** One in-flight memory upload. Authentication is applied by the route first. */
export function createBoundedUpload(): RequestHandler {
  const parse = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0, parts: 1, fieldNameSize: 64, headerPairs: 32 },
  }).single("file");
  let busy = false;
  return (req, res, next) => {
    const length = req.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) {
      res.status(413).json({ message: "Upload excede o limite permitido." }); return;
    }
    if (busy) { res.status(429).json({ message: "Outro upload está em processamento." }); return; }
    busy = true;
    let released = false;
    const release = () => { if (!released) { released = true; busy = false; } };
    res.once("finish", release);
    res.once("close", release);
    parse(req, res, error => {
      if (error) {
        release();
        if (!res.headersSent && !res.destroyed) res.status(413).json({ message: "Upload recusado pelos limites de tamanho ou estrutura." });
        return;
      }
      next();
    });
  };
}
