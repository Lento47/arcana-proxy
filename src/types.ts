export interface UserInfo {
  id: string
  tier: "free" | "pro" | "team" | "enterprise"
}

export interface AnalyticsEvent {
  userId: string
  model: string
  tokensIn: number
  tokensOut: number
  costIn: number
  costOut: number
  duration: number
  timestamp: number
}
