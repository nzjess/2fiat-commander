CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`label` text NOT NULL,
	`token_enc` text,
	`token_hash` text NOT NULL,
	`sid_enc` text,
	`sid_expires_at` text,
	`ledger_dirty_from` text,
	`archived_at` text,
	`replaced_by_account_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`replaced_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_user_token` ON `accounts` (`user_id`,`token_hash`);--> statement-breakpoint
CREATE TABLE `activities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`authorized_amount_cents` integer,
	`attempted_amount_cents` integer,
	`requested_amount_cents` integer,
	`fee_cents` integer,
	`currency` text NOT NULL,
	`occurred_at` text NOT NULL,
	`settled_at` text,
	`description` text NOT NULL,
	`posted_description` text,
	`order_twofiat_id` text,
	`transfer_id` text,
	`counterpart_card_id` integer,
	`flags` text NOT NULL,
	`normalizer_version` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`counterpart_card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activities_account_occurred` ON `activities` (`account_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activities_card_occurred` ON `activities` (`card_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `activities_account_kind_occurred` ON `activities` (`account_id`,`kind`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `activities_account_key` ON `activities` (`account_id`,`key`);--> statement-breakpoint
CREATE TABLE `activity_annotations` (
	`activity_id` integer PRIMARY KEY NOT NULL,
	`category_id` integer,
	`note` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `activity_annotations_category` ON `activity_annotations` (`category_id`);--> statement-breakpoint
CREATE TABLE `activity_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`activity_id` integer NOT NULL,
	`raw_transaction_id` integer,
	`raw_order_id` integer,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_transaction_id`) REFERENCES `raw_transactions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_order_id`) REFERENCES `raw_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "activity_sources_one_source" CHECK(("activity_sources"."raw_transaction_id" IS NULL) <> ("activity_sources"."raw_order_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activity_sources_raw_transaction_id_unique` ON `activity_sources` (`raw_transaction_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `activity_sources_raw_order_id_unique` ON `activity_sources` (`raw_order_id`);--> statement-breakpoint
CREATE INDEX `activity_sources_activity` ON `activity_sources` (`activity_id`);--> statement-breakpoint
CREATE TABLE `balance_observations` (
	`card_id` integer NOT NULL,
	`sync_id` integer NOT NULL,
	`reported_cents` integer NOT NULL,
	`observed_at` text NOT NULL,
	`transient` integer NOT NULL,
	PRIMARY KEY(`card_id`, `sync_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sync_id`) REFERENCES `syncs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `balance_snapshots` (
	`card_id` integer NOT NULL,
	`evaluation_id` integer NOT NULL,
	`observed_sync_id` integer NOT NULL,
	`reported_cents` integer NOT NULL,
	`ledger_cents` integer NOT NULL,
	`holds_cents` integer NOT NULL,
	`gap_cents` integer NOT NULL,
	`transient` integer NOT NULL,
	PRIMARY KEY(`card_id`, `evaluation_id`),
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`observed_sync_id`) REFERENCES `syncs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`logical_card_id` integer NOT NULL,
	`is_current` integer NOT NULL,
	`twofiat_id` text NOT NULL,
	`alias` text NOT NULL,
	`masked_number` text NOT NULL,
	`currency` text NOT NULL,
	`product` text NOT NULL,
	`status` text,
	`issued_at` text,
	`expires_at` text,
	`raw` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`logical_card_id`,`account_id`) REFERENCES `logical_cards`(`id`,`account_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cards_logical_card` ON `cards` (`logical_card_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cards_one_current` ON `cards` (`logical_card_id`) WHERE is_current = 1;--> statement-breakpoint
CREATE UNIQUE INDEX `cards_account_twofiat` ON `cards` (`account_id`,`twofiat_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_user_name` ON `categories` (`user_id`,`name`);--> statement-breakpoint
CREATE TABLE `evaluations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`sync_id` integer,
	`as_of` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sync_id`) REFERENCES `syncs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evaluations_account` ON `evaluations` (`account_id`,`id`);--> statement-breakpoint
CREATE TABLE `findings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`card_id` integer NOT NULL,
	`kind` text NOT NULL,
	`fingerprint` text NOT NULL,
	`cents` integer,
	`message` text NOT NULL,
	`activity_ids` text NOT NULL,
	`first_seen_evaluation_id` integer NOT NULL,
	`last_seen_evaluation_id` integer NOT NULL,
	`resolved_evaluation_id` integer,
	`explained_at` text,
	`explanation` text,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`first_seen_evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`last_seen_evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resolved_evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_card_fingerprint` ON `findings` (`card_id`,`fingerprint`);--> statement-breakpoint
CREATE TABLE `logical_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `logical_cards_id_account` ON `logical_cards` (`id`,`account_id`);--> statement-breakpoint
CREATE TABLE `opening_balances` (
	`card_id` integer PRIMARY KEY NOT NULL,
	`cents` integer NOT NULL,
	`source` text NOT NULL,
	`set_at` text NOT NULL,
	`set_by_evaluation_id` integer,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by_evaluation_id`) REFERENCES `evaluations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `raw_orders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`card_id` integer,
	`twofiat_id` text NOT NULL,
	`created_at` text NOT NULL,
	`raw` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `raw_orders_account_created` ON `raw_orders` (`account_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `raw_orders_account_twofiat` ON `raw_orders` (`account_id`,`twofiat_id`);--> statement-breakpoint
CREATE TABLE `raw_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`card_id` integer NOT NULL,
	`twofiat_id` text NOT NULL,
	`created_at` text NOT NULL,
	`raw` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `raw_transactions_account_created` ON `raw_transactions` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `raw_transactions_card_created` ON `raw_transactions` (`card_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `raw_transactions_account_twofiat` ON `raw_transactions` (`account_id`,`twofiat_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `syncs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer NOT NULL,
	`trigger` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text NOT NULL,
	`failed_stage` text,
	`error` text,
	`ingested_at` text,
	`rows_new` integer DEFAULT 0 NOT NULL,
	`rows_updated` integer DEFAULT 0 NOT NULL,
	`rows_missing` integer DEFAULT 0 NOT NULL,
	`window_from` text,
	`window_to` text,
	`orders_from` text,
	`normalized_from` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `syncs_account_started` ON `syncs` (`account_id`,`started_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `syncs_one_running` ON `syncs` (`account_id`) WHERE status = 'running';--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);