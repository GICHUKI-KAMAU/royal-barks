export type Role = (typeof ROLES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];
export type ChamaCycleState = (typeof CHAMA_CYCLE_STATES)[number];

export interface SafeUser {
  id: number;
  auth_user_id: string;
  member_id: number | null;
  display_name: string;
  email: string;
  account_status: "INVITED" | "ACTIVE" | "SUSPENDED";
  roles: Role[];
  member: {
    id: number;
    name: string;
    status: MembershipStatus;
  } | null;
}

export const ROLES: readonly ["MEMBER", "TREASURER", "CHAMA_COORDINATOR", "ADMIN"];
export const MEMBERSHIP_STATUSES: readonly ["ACTIVE", "DORMANT", "STATUS TO CONFIRM"];
export const CHAMA_CYCLE_STATES: readonly ChamaCycleState[];
