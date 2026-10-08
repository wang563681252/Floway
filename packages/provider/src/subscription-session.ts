export interface SubscriptionClientSession {
  sessionId: string;
  threadId: string;
  turnId: string | null;
}
