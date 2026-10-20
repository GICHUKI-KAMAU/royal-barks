ALTER FUNCTION public.prevent_active_admin_suspension()
SET search_path = pg_catalog, public;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;

CREATE INDEX IF NOT EXISTS status_history_member_date_idx
  ON public.status_history(member_id, effective_date DESC);
CREATE INDEX IF NOT EXISTS obligations_member_category_date_idx
  ON public.obligations(member_id, category, obligation_date);
CREATE INDEX IF NOT EXISTS transactions_member_category_date_idx
  ON public.transactions(member_id, category, transaction_date);
CREATE INDEX IF NOT EXISTS attendance_member_idx ON public.attendance(member_id);
CREATE INDEX IF NOT EXISTS import_rows_import_idx ON public.import_rows(import_id);
CREATE INDEX IF NOT EXISTS opening_balances_member_type_idx
  ON public.opening_balances(member_id, balance_type);
CREATE INDEX IF NOT EXISTS role_assignments_assigned_by_idx
  ON public.role_assignments(assigned_by);
CREATE INDEX IF NOT EXISTS auth_tokens_profile_purpose_idx
  ON public.auth_tokens(profile_id, purpose, used_at, expires_at);
CREATE INDEX IF NOT EXISTS auth_sessions_profile_expiry_idx
  ON public.auth_sessions(profile_id, expires_at, revoked_at);
CREATE INDEX IF NOT EXISTS auth_audit_actor_created_idx
  ON public.auth_audit(actor_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS auth_audit_target_created_idx
  ON public.auth_audit(target_profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS chama_cycles_created_by_idx ON public.chama_cycles(created_by);
CREATE INDEX IF NOT EXISTS chama_participants_member_idx ON public.chama_participants(member_id);
CREATE INDEX IF NOT EXISTS chama_cards_cycle_position_idx
  ON public.chama_cards(cycle_id, display_position);
CREATE INDEX IF NOT EXISTS chama_selections_card_idx ON public.chama_selections(card_id);
CREATE INDEX IF NOT EXISTS chama_selections_participant_idx
  ON public.chama_selections(participant_id);
CREATE INDEX IF NOT EXISTS chama_selection_events_cycle_idx
  ON public.chama_selection_events(cycle_id);
CREATE INDEX IF NOT EXISTS chama_selection_events_selection_idx
  ON public.chama_selection_events(selection_id);
CREATE INDEX IF NOT EXISTS chama_selection_events_actor_idx
  ON public.chama_selection_events(actor_profile_id);
CREATE INDEX IF NOT EXISTS chama_payouts_selection_idx ON public.chama_payouts(selection_id);
CREATE INDEX IF NOT EXISTS chama_payouts_participant_idx ON public.chama_payouts(participant_id);
CREATE INDEX IF NOT EXISTS chama_payouts_recorded_by_idx ON public.chama_payouts(recorded_by);
CREATE INDEX IF NOT EXISTS chama_payout_events_payout_idx
  ON public.chama_payout_events(payout_id);
CREATE INDEX IF NOT EXISTS chama_payout_events_actor_idx
  ON public.chama_payout_events(actor_profile_id);
CREATE INDEX IF NOT EXISTS chama_selection_corrections_cycle_idx
  ON public.chama_selection_corrections(cycle_id);
CREATE INDEX IF NOT EXISTS chama_selection_corrections_selection_idx
  ON public.chama_selection_corrections(selection_id);
CREATE INDEX IF NOT EXISTS chama_selection_corrections_previous_card_idx
  ON public.chama_selection_corrections(previous_card_id);
CREATE INDEX IF NOT EXISTS chama_selection_corrections_replacement_card_idx
  ON public.chama_selection_corrections(replacement_card_id);
CREATE INDEX IF NOT EXISTS chama_selection_corrections_other_selection_idx
  ON public.chama_selection_corrections(other_selection_id);
CREATE INDEX IF NOT EXISTS chama_selection_corrections_actor_idx
  ON public.chama_selection_corrections(actor_profile_id);
CREATE INDEX IF NOT EXISTS chama_cycle_history_cycle_idx
  ON public.chama_cycle_history(cycle_id);
CREATE INDEX IF NOT EXISTS chama_cycle_history_actor_idx
  ON public.chama_cycle_history(actor_profile_id);
CREATE INDEX IF NOT EXISTS chama_audit_events_cycle_idx
  ON public.chama_audit_events(cycle_id);
CREATE INDEX IF NOT EXISTS chama_audit_events_actor_idx
  ON public.chama_audit_events(actor_profile_id);
