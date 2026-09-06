import { Shield } from "lucide-react";
import { useState } from "react";

export function BrandLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const [hasError, setHasError] = useState(false);

  const sizeClasses =
    size === "lg"
      ? "w-14 h-14"
      : size === "sm"
        ? "w-10 h-10"
        : "w-8 h-8";

  if (hasError) {
    return (
      <div className={`${sizeClasses} rounded-lg bg-primary/10 flex items-center justify-center`}>
        <Shield className={`${size === "lg" ? "w-8 h-8" : size === "sm" ? "w-5 h-5" : "w-6 h-6"} text-primary cyber-glow-text`} />
      </div>
    );
  }

  return (
    <img
      src="/branding/cybersafe-logo.png"
      alt="CyberSafe"
      className={`${sizeClasses} rounded-lg object-contain`}
      onError={() => setHasError(true)}
      draggable={false}
    />
  );
}
