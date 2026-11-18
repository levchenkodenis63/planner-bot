ALTER TABLE project_tasks ADD COLUMN deadline TEXT;
UPDATE project_tasks SET deadline = date(created_at, '+7 days') WHERE deadline IS NULL;
