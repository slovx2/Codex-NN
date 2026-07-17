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

export type MarketplaceUser = {
  id: string;
  publicName: string;
};

export type MarketplaceAuthState = {
  loggedIn: boolean;
  pending: boolean;
  user: MarketplaceUser | null;
};

export type MarketplaceLoginResult = {
  status: "idle" | "pending" | "complete";
  auth: MarketplaceAuthState;
};

export type MarketplaceThemeCard = {
  themeId: string;
  versionId: string;
  manifestId: string;
  name: string;
  tagline: string;
  authorName: string;
  versionNumber: number;
  downloadCount: number;
  cardPreviewUrl: string;
  publishedAt: string;
  previewDataUrl: string;
};

export type MarketplaceThemeDetail = MarketplaceThemeCard & {
  quote: string;
  manifest: unknown;
  detailPreviewUrl: string;
  detailPreviewDataUrl: string;
  packageSize: number;
  packageSha256: string;
};

export type MarketplacePage = {
  items: MarketplaceThemeCard[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
};

export type MarketplaceUploadRecord = {
  themeId: string;
  versionId: string;
  manifestId: string;
  versionNumber: number;
  status: string;
  name: string;
  tagline: string;
  packageSha256: string;
  packageSize: number;
  createdAt: string;
  reviewedAt: string | null;
};

export type MarketplaceUploadOutcome = {
  uploaded: boolean;
  needsConfirmation: boolean;
  isUpdate: boolean;
  name: string;
  previousVersionNumber: number | null;
  record: MarketplaceUploadRecord | null;
};

export type MarketplaceLocalSyncState = {
  localThemeId: string;
  manifestId: string;
  linked: boolean;
  themeId: string | null;
  versionId: string | null;
  versionNumber: number | null;
  packageSha256: string | null;
  role: "consumer" | "publisher" | null;
  localChanged: boolean;
};
