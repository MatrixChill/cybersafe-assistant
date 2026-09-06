import { Shield } from "lucide-react";
import { useState } from "react";

export function BrandLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const [hasError, setHasError] = useState(false);

  const sizeClasses =
    size === "lg"
      ? "w-12 h-12"
      : size === "sm"
        ? "w-8 h-8"
        : "w-10 h-10";

  if (hasError) {
    return (
      <div className={`${sizeClasses} rounded-lg bg-primary/10 flex items-center justify-center`}>
        <Shield className={`${size === "lg" ? "w-8 h-8" : size === "sm" ? "w-5 h-5" : "w-6 h-6"} text-primary cyber-glow-text`} />
      </div>
    );
  }

  return (
    <img
      // CS Shield (símbolo compacto oficial), legível mesmo em 32px.
      src="/branding/icons/cybersafe-shield-cs-simple-32.png"
      alt="CyberSafe"
      className={`${sizeClasses} rounded-lg object-contain`}
      onError={(e) => {
        // Fallback para a logo completa se o 32px não existir.
        const img = e.currentTarget;
        if (img.src.includes("cybersafe-shield-cs-simple-32")) {
          img.src = "/branding/icons/cybersafe-shield-cs-32.png";
        } else {
          setHasError(true);
        }
      }}
      draggable={false}
    />
  );
}