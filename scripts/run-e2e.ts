import { runLocalE2e } from "./e2e-utils";

process.exitCode = await runLocalE2e("api");
