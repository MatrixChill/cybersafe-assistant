import { motion, AnimatePresence } from "framer-motion";
import { Shield, Search, Loader2 } from "lucide-react";
import "./ScanRadar.css";

interface ScanRadarProps {
  scanning: boolean;
  statusText?: string;
}

export default function ScanRadar({ scanning, statusText }: ScanRadarProps) {
  return (
    <div className={`scan-radar-wrapper ${scanning ? "is-scanning" : ""}`}>
      <div className="radar-circle">
        {/* Radar Rotating Sweep */}
        <AnimatePresence>
          {scanning && (
            <motion.div
              className="radar-sweep"
              initial={{ rotate: 0 }}
              animate={{ rotate: 360 }}
              transition={{ repeat: Infinity, duration: 3, ease: "linear" }}
            />
          )}
        </AnimatePresence>

        {/* Circular Grid Lines */}
        <div className="radar-ring ring-1" />
        <div className="radar-ring ring-2" />
        <div className="radar-ring ring-3" />
        
        {/* Scanning Blips */}
        <AnimatePresence>
          {scanning && [1, 2, 3].map((id) => (
            <motion.div
              key={id}
              className={`radar-blip blip-${id}`}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ 
                scale: [0, 1.2, 0],
                opacity: [0, 0.8, 0],
              }}
              transition={{
                repeat: Infinity,
                duration: 2,
                delay: id * 0.5,
              }}
            />
          ))}
        </AnimatePresence>

        <div className="radar-center">
          {scanning ? (
            <motion.div
              animate={{ scale: [1, 1.1, 1] }}
              transition={{ repeat: Infinity, duration: 1.5 }}
            >
              <Search className="radar-icon" />
            </motion.div>
          ) : (
            <Shield className="radar-icon" />
          )}
        </div>
      </div>

      <div className="radar-status">
        <div className="status-header">
          {scanning ? (
            <Loader2 className="spinning-icon" />
          ) : (
            <div className="status-dot online" />
          )}
          <span>{scanning ? "ANÁLISE ATIVA" : "À ESPERA"}</span>
        </div>
        <p className="status-message">
          {statusText || (scanning ? "A analisar assinaturas de ficheiro..." : "Pronto para nova verificação")}
        </p>
      </div>
    </div>
  );
}
