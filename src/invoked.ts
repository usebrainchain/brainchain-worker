/** How the user started this CLI: through npx, or as the installed binary. Hints name the same, so they can be pasted as they are. */
export const commandName = (env: NodeJS.ProcessEnv = process.env) => (env.npm_command === "exec" ? "npx brainchain-worker" : "brainchain-worker");

export const CLI = commandName();

/** A command to run, as a hint shows it: `brainchain-worker status`, or with npx in front when npx started this one. */
export const cli = (args: string) => `\`${CLI} ${args}\``;
