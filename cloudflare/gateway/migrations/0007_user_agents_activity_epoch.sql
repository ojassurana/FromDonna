-- Activity epoch: bumped on every inject so post-turn pause can detect a newer
-- message and skip pausing a sandbox that is busy again.
ALTER TABLE user_agents ADD COLUMN activity_epoch INTEGER NOT NULL DEFAULT 0;
