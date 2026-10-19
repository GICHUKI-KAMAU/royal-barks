import type { MembershipStatus, SafeUser } from "../../shared/contracts.js";

export interface Member {
  id: number;
  name: string;
  status: MembershipStatus;
  categories: Record<string, MemberCategoryBalance>;
  status_history: MemberStatusHistory[];
}

export interface MemberCategoryBalance {
  current_due: number;
  opening_arrears: number;
  obligations_new: number;
  paid_new: number;
  historical_paid?: number;
}

export interface MemberStatusHistory {
  previous_status: MembershipStatus | "NONE";
  new_status: MembershipStatus;
  effective_date: string;
  reason: string;
  official: string;
  created_at?: string;
}

export interface DashboardSummary {
  members: { active: number; dormant: number; confirm: number; total: number };
  new_paid: number | null;
  new_obligations: number | null;
  opening_arrears: number | null;
  reference: Record<string, number> | null;
}

export interface LedgerEntry {
  id: number;
  kind: "payment" | "obligation";
  member_id: number;
  name: string;
  category: string;
  amount: number;
  record_date: string;
  actor: string;
  note: string;
}

export interface MeetingRecord {
  id: number;
  meeting_date: string;
  title: string;
  created_by: string;
  attendance: Array<{ member_id: number; name: string; attended: boolean }>;
}

export interface HistoricalImport {
  id: number;
  statement_date: string;
  source: string;
  imported_by: string;
  reviewed_by: string;
  approved_by: string;
  rows: Array<{
    id: number;
    member_name: string;
    existing_status: MembershipStatus;
    amounts: Record<string, number | null>;
    issues: string[];
  }>;
  reconciliation: Array<{ status: string }>;
  supplemental: {
    aggregate_rows?: Array<{
      member_name: string;
      amounts: Record<string, number | null>;
    }>;
  };
}

export interface FinancialReportCategory {
  historical_paid: number;
  opening_arrears: number;
  obligations: number;
  payments: number;
  due: number;
}

export interface FinancialReportMember {
  member_id: number;
  member_name: string;
  status_as_of: MembershipStatus;
  categories: Record<string, FinancialReportCategory>;
}

export interface FinancialReport {
  as_of: string;
  members: FinancialReportMember[];
  opening_balances_are_separate: boolean;
  transaction_level_history_complete: boolean;
}

export interface MemberStatusImpact {
  current_status_on_date: MembershipStatus;
  proposed_status: MembershipStatus;
  effective_date: string;
  opening_arrears: number;
  existing_future_obligations: number;
  existing_future_obligation_amount: number;
  historical_balances_preserved: boolean;
  dormant_period_charges_generated: boolean;
}

export interface FinancialImportPreview {
  duplicate: boolean;
  rows: Array<{
    member_name: string;
    existing_status: MembershipStatus;
    total_paid: number | null;
    total_unpaid: number | null;
    issues: string[];
  }>;
  reconciliation: Array<{
    category: string;
    imported: number;
    reference: number;
    difference: number;
    status: string;
  }>;
  reference: Record<string, number>;
  supplemental: {
    aggregate_rows: Array<Record<string, string | number | null>>;
  };
}

export interface FinancialImportReview extends FinancialImportPreview {
  payload: Record<string, unknown>;
}

export interface UserAccount extends AuthenticatedUser {
  email_verified_at: string | null;
  created_at: string;
}

export type AuthenticatedUser = SafeUser;
