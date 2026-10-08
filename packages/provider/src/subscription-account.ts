export interface SubscriptionAccountStatus {
  identity: string | null;
  health: 'active' | 'session_terminated' | 'refresh_failed';
  observedAt: number | null;
  utilization: number | null;
  unavailableUntil: number | null;
}
