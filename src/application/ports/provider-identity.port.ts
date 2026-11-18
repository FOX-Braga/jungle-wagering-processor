/**
 * Extension point for the future HTTP guard backed by an external OIDC provider.
 * The guard can bind the authenticated provider to the provider in a wager command.
 */
export interface ProviderIdentityPort {
  authenticate(bearerToken: string): Promise<{ providerId: string } | null>;
}
