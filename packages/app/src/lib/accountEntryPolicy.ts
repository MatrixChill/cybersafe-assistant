export type AccountPolicy = "required" | "local-optional";

export function accountEntrySurface(
  policy: AccountPolicy, loading: boolean, authenticated: boolean, requested: boolean,
): "loading" | "account" | "app" {
  if (loading) return "loading";
  if (authenticated) return "app";
  return policy === "local-optional" && !requested ? "app" : "account";
}
