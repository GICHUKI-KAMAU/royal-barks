CREATE INDEX IF NOT EXISTS import_approvals_imported_by_idx
  ON public.import_approvals(imported_by_profile_id);
CREATE INDEX IF NOT EXISTS import_approvals_reviewed_by_idx
  ON public.import_approvals(reviewed_by_profile_id);
CREATE INDEX IF NOT EXISTS import_approvals_approved_by_idx
  ON public.import_approvals(approved_by_profile_id);
