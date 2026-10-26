CREATE TABLE `fork_legacy_unreleased_environments` (
	`environment_id` text PRIMARY KEY NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `fork_legacy_unreleased_environments` (`environment_id`, `recorded_at`)
SELECT `held`.`environment_id`, CAST(strftime('%s', 'now') AS integer) * 1000
FROM (
	SELECT `environment_id`, count(*) AS `thread_count`
	FROM `threads`
	WHERE `environment_id` IS NOT NULL
	GROUP BY `environment_id`
) AS `held`
INNER JOIN `environments` ON `environments`.`id` = `held`.`environment_id`
WHERE `held`.`thread_count` > (
	SELECT count(*)
	FROM `environment_release_consents`
	INNER JOIN `threads` ON `threads`.`id` = `environment_release_consents`.`thread_id`
	WHERE `environment_release_consents`.`environment_id` = `held`.`environment_id`
		AND `threads`.`environment_id` = `held`.`environment_id`
);
