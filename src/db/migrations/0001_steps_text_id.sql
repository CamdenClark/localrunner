-- Migrate steps.id from integer to text (for UUID support)
-- and step_logs.step_id from integer to text to match.

CREATE TABLE `steps_new` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`conclusion` text,
	`started_at` integer,
	`completed_at` integer,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `steps_new` SELECT CAST(`id` AS text), `job_id`, `name`, `status`, `conclusion`, `started_at`, `completed_at`, `sort_order` FROM `steps`;
--> statement-breakpoint
DROP TABLE `steps`;
--> statement-breakpoint
ALTER TABLE `steps_new` RENAME TO `steps`;
--> statement-breakpoint
CREATE TABLE `step_logs_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_id` text NOT NULL,
	`line_number` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `step_logs_new` SELECT `id`, CAST(`step_id` AS text), `line_number`, `content` FROM `step_logs`;
--> statement-breakpoint
DROP TABLE `step_logs`;
--> statement-breakpoint
ALTER TABLE `step_logs_new` RENAME TO `step_logs`;
