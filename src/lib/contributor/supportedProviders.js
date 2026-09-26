// The contributor portal uses the shared OAuthModal without local-token import,
// Xiaomi's desktop-only ECDH flow, or GitLab's custom client-ID form.
export const UNSUPPORTED_CONTRIBUTOR_PROVIDERS = new Set(["cursor", "xiaomi-mimo", "gitlab"]);

export function isContributorProviderSupported(id, provider) {
  return Boolean(provider && !provider.hidden && !UNSUPPORTED_CONTRIBUTOR_PROVIDERS.has(id));
}
