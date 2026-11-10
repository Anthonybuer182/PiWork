const REPO_URL = 'https://github.com/Anthonybuer182/PiWork';

export type FeedbackPlatform = 'darwin' | 'win32' | 'linux' | null;

const PLATFORM_LABELS: Record<Exclude<FeedbackPlatform, null>, string> = {
  darwin: 'macOS',
  win32: 'Windows',
  linux: 'Linux',
};

/**
 * GitHub issue forms let the URL pre-fill fields by their `id`
 * (`?template=bug_report.yml&version=…&os=…`), so a bug report opens with the
 * build details already in place and the user only has to describe what broke.
 * Keep these ids in sync with `.github/ISSUE_TEMPLATE/bug_report.yml`.
 */
function query(params: Record<string, string>): string {
  // `URLSearchParams` writes spaces as `+`; GitHub's prefill expects the
  // standard percent-encoding (`%20`) that `encodeURIComponent` produces.
  return new URLSearchParams(params).toString().replace(/\+/g, '%20');
}

export function bugReportUrl(options: {
  version?: string | null;
  platform: FeedbackPlatform;
}): string {
  const params: Record<string, string> = { template: 'bug_report.yml' };
  if (options.version) params.version = options.version;
  if (options.platform) params.os = PLATFORM_LABELS[options.platform];
  return `${REPO_URL}/issues/new?${query(params)}`;
}

/** Feature requests carry no build data worth pre-filling. */
export function featureRequestUrl(): string {
  return `${REPO_URL}/issues/new?${query({ template: 'feature_request.yml' })}`;
}
