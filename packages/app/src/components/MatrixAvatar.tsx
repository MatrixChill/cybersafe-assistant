import { cn } from "@/lib/utils";
import { useState } from "react";
import { useAppearance } from "@/contexts/AppearanceContext";

type Mood = "safe" | "guide" | "alert" | "success" | "happy" | "defender" | "avatar" | "mini";

// Retratos oficiais da Matrix (variante "bust" — rosto e ombros — para avatares
// pequenos/redondos; avatar/mini já são quadrados focados no rosto).
const MOOD_ASSET: Record<Mood, string> = {
  safe: "/branding/matrix/matrix-safe-bust-96.png",
  guide: "/branding/matrix/matrix-guide-bust-96.png",
  alert: "/branding/matrix/matrix-alert-bust-96.png",
  success: "/branding/matrix/matrix-success-bust-96.png",
  happy: "/branding/matrix/matrix-happy-bust-96.png",
  defender: "/branding/matrix/matrix-defender-bust-96.png",
  avatar: "/branding/matrix/matrix-avatar-96.png",
  mini: "/branding/matrix/matrix-mini-96.png",
};

interface MatrixAvatarProps {
  mood?: Mood;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
  rounded?: boolean;
}

export function MatrixAvatar({ mood = "safe", size = "md", className, rounded = false }: MatrixAvatarProps) {
  const [hasError, setHasError] = useState(false);
  const { identity } = useAppearance();

  const sizeClasses =
    size === "xl"
      ? "w-28 h-28"
      : size === "lg"
        ? "w-20 h-20"
        : size === "sm"
          ? "w-10 h-10"
          : "w-14 h-14";

  const isMatrixTerminal = identity === "matrix-terminal";
  const containerRadius = rounded
    ? "rounded-full"
    : isMatrixTerminal
      ? "rounded-md"
      : "rounded-2xl";

  return (
    <div
      className={cn(
        "relative shrink-0 overflow-hidden flex items-center justify-center matrix-avatar-wrapper",
        containerRadius,
        sizeClasses,
        className,
      )}
    >
      {!hasError ? (
        <img
          src={MOOD_ASSET[mood]}
          alt="Matrix"
          className="w-full h-full object-cover"
          onError={() => setHasError(true)}
          draggable={false}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center font-mono font-bold text-primary text-xs cyber-glow-text bg-primary/5 rounded-inherit">
          {"</>"}
        </div>
      )}
    </div>
  );
}

export function matrixMoodForStatus(status: "idle" | "scanning" | "warning" | "error" | "completed"): Mood {
  switch (status) {
    case "scanning":
      return "defender";
    case "warning":
      return "alert";
    case "error":
      return "alert";
    case "completed":
      return "success";
    default:
      return "safe";
  }
}