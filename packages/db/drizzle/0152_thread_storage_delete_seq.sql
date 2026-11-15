ALTER TABLE `threads` ADD `storage_delete_seq` integer;--> statement-breakpoint
CREATE INDEX `threads_storage_delete_seq_idx` ON `threads` (`storage_delete_seq`);