CREATE TABLE `fork_legacy_unreleased_environments` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `fork_legacy_unreleased_environments` (`environment_id`, `recorded_at`)
SELECT DISTINCT `threads`.`environment_id`, CAST(strftime('%s', 'now') AS integer) * 1000
FROM `threads`
INNER JOIN `environments` ON `environments`.`id` = `threads`.`environment_id`
WHERE NOT EXISTS (
	SELECT 1 FROM `environment_release_consents`
	WHERE `environment_release_consents`.`environment_id` = `threads`.`environment_id`
		AND `environment_release_consents`.`thread_id` = `threads`.`id`
);
