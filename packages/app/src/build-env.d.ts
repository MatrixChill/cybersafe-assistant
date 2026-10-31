interface BuildIdentityEnv {
  version: string;
  buildId: string;
  commit: string;
}

declare const __BUILD__: BuildIdentityEnv | undefined;
