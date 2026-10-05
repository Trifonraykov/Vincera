import type { AuthUser } from "@/lib/auth/user"

/** A plain `AuthUser` for pure authorization tests. */
export function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "0190a000-0000-7000-8000-000000000001",
    email: "ada@example.com",
    name: "Ada",
    image: null,
    roles: ["creator"],
    activeRole: "creator",
    status: "active",
    onboardingCompletedAt: null,
    ...overrides,
  }
}

export const OTHER_USER_ID = "0190a000-0000-7000-8000-000000000002"
