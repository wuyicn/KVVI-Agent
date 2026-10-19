-- Never classify pre-existing links (or old writers' new links) as qualified.
ALTER TABLE visitor_links ADD COLUMN IF NOT EXISTS submission_protocol text NOT NULL DEFAULT 'legacy-unknown';
