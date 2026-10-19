import type { ChamaCycleState } from "../../../../shared/contracts.js";

export interface ChamaCycleSummary {
  id: string;
  name: string;
  state: ChamaCycleState;
}

export interface ChamaCycle extends ChamaCycleSummary {
  description: string;
  expected_start_date: string;
  expected_end_date: string;
  first_payout_date: string;
  opt_in_deadline: string;
  duration_months: number;
  min_seats: number;
  max_seats: number;
  monthly_amount_per_seat: number | null;
  own_registration?: { requested_seats: number } | null;
  participant_count?: number;
  participants?: Array<{ id: string; member_name: string; seats: number }>;
}

export interface ChamaCard {
  card_id: string;
  selection_id: string | null;
  official_number: number | null;
  selected: boolean;
  selected_by: string | null;
}

export interface ChamaBoard {
  cards: ChamaCard[];
  remaining_cards: number;
  selected_count: number;
  total_cards: number;
  own: { picked: number; seats: number; remaining: number };
  corrections?: Array<{
    previous_card_number: number;
    replacement_card_number: number;
    reason: string;
  }>;
}

export interface ChamaPayout {
  id: number;
  official_card_number: number;
  expected_date: string;
  status: string;
  member_name: string;
  actual_date: string | null;
  reference_number: string | null;
}
