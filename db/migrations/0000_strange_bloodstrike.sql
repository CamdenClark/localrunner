CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`finalized` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`conclusion` text,
	`started_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_name` text NOT NULL,
	`job_name` text NOT NULL,
	`event_name` text NOT NULL,
	`event_payload` text,
	`repo_owner` text,
	`repo_name` text,
	`repo_full_name` text,
	`sha` text,
	`ref` text,
	`conclusion` text,
	`started_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `step_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`step_id` integer NOT NULL,
	`line_number` integer NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `steps`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`name` text NOT NULL,
	`conclusion` text,
	`started_at` integer,
	`completed_at` integer,
	`sort_order` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action
);
