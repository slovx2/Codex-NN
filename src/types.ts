export type SessionState = "off" | "starting" | "active" | "paused" | "stale" | "error";

export type ThemeSummary = {
  id: string;
  name: string;
  tagline: string;
  quote: string;
  accent: string;
  previewDataUrl: string;
  active: boolean;
  builtIn: boolean;
};

export type AppSnapshot = {
  session: SessionState;
  port: number | null;
  watcherRunning: boolean;
  codex: {
    installed: boolean;
    running: boolean;
    version: string | null;
    path: string | null;
    message: string | null;
  };
  activeTheme: ThemeSummary | null;
  lastError: string | null;
};

export type ThemeInstallOutcome = {
  installed: boolean;
  updated: boolean;
  needsConfirmation: boolean;
  theme: ThemeSummary;
};

export type ThemePackageOutcome = {
  packagePath: string;
  themeId: string;
  themeName: string;
  packageBytes: number;
};

export type ThemeDesignerPluginStatus = {
  installed: boolean;
  managed: boolean;
  conflict: boolean;
  version: string;
  message: string | null;
};

export type DiagnosticReport = {
  pass: boolean;
  checks: Array<{ name: string; pass: boolean; detail: string }>;
};

export type VerificationReport = {
  pass: boolean;
  port: number | null;
  targetCount: number;
  screenshotPath: string | null;
  details: unknown;
  message: string;
};
